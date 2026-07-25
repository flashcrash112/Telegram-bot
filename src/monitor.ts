/** Position monitor: polls prices for open positions and executes the
 * take-profit ladder / stop-loss.
 *
 * Paper positions (opened while DRY_RUN was on) are simulated: exits are
 * logged as "DRY RUN: would sell ..." and recorded, but no transaction
 * is ever sent. That makes a dry run a complete paper-trading record —
 * entries, exits and multiples — without risking funds.
 */
import { config } from "./config.js";
import { EVM_CHAINS, SOLANA_KEY, buyEngineFor } from "./chains.js";
import { makeLog } from "./log.js";
import {
  Position, loadPositions, positionKey, savePositions, updatePosition,
} from "./positions.js";
import { decideSell, fractionOfHeldBalance, parseTakeProfit } from "./takeProfit.js";
import * as evmSwap from "./evmSwap.js";
import * as relaySwap from "./relaySwap.js";
import * as solanaSwap from "./solanaSwap.js";

const log = makeLog("monitor");

const DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens/";
const MAX_ADDRESSES_PER_REQUEST = 30;
/** Stop retrying a position after this many consecutive sell failures. */
const MAX_SELL_FAILURES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current USD price per token address, from the deepest pair. */
export async function fetchPrices(positions: Position[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const addresses = [...new Set(positions.map((p) => p.address))];

  for (let i = 0; i < addresses.length; i += MAX_ADDRESSES_PER_REQUEST) {
    const batch = addresses.slice(i, i + MAX_ADDRESSES_PER_REQUEST);
    let pairs: any[] = [];
    try {
      const resp = await fetch(DEXSCREENER_TOKENS_URL + batch.join(","), {
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status !== 200) continue;
      pairs = (await resp.json())?.pairs ?? [];
    } catch {
      continue; // transient: try again next cycle
    }

    // Keep the deepest pair per token address.
    const deepest = new Map<string, any>();
    for (const pair of pairs) {
      const address = (pair?.baseToken?.address ?? "").toLowerCase();
      if (!address) continue;
      const best = deepest.get(address);
      if (!best || (pair?.liquidity?.usd ?? 0) > (best?.liquidity?.usd ?? 0)) {
        deepest.set(address, pair);
      }
    }
    for (const [address, pair] of deepest) {
      const price = parseFloat(pair?.priceUsd ?? "");
      if (price > 0) prices.set(address, price);
    }
  }
  return prices;
}

/** Sell a fraction of what the wallet currently holds of a token. */
async function executeSell(position: Position, fractionOfHeld: number): Promise<string> {
  const isSolana = position.chain === SOLANA_KEY;
  const chain = EVM_CHAINS[position.chain];

  const { raw, decimals } = isSolana
    ? await solanaSwap.tokenBalance(position.address)
    : await evmSwap.tokenBalance(chain, position.address);
  if (raw <= 0n) {
    throw new Error("wallet holds none of this token (already sold, or the buy never landed)");
  }

  // Sell the whole balance when the fraction rounds to everything, so no
  // dust is left behind on a final exit.
  const amount =
    fractionOfHeld >= 0.999
      ? raw
      : (raw * BigInt(Math.round(fractionOfHeld * 1_000_000))) / 1_000_000n;
  if (amount <= 0n) throw new Error("computed sell amount rounded to zero");

  const human = Number(amount) / 10 ** decimals;
  log.info(
    `selling ${human.toLocaleString("en-US", { maximumFractionDigits: 4 })} ` +
      `${position.symbol} (${(fractionOfHeld * 100).toFixed(1)}% of holdings) on ${position.chain}`
  );

  if (isSolana) return solanaSwap.sell(position.address, amount);
  if (buyEngineFor(position.chain) === "relay") {
    return relaySwap.sell(position.chain, position.address, amount);
  }
  return evmSwap.sell(chain, position.address, amount);
}

/** One monitor pass over all open positions. Exposed for testing. */
export async function checkPositions(): Promise<void> {
  const open = loadPositions().filter((p) => !p.closed);
  if (!open.length) return;

  const tiers = parseTakeProfit(config.TAKE_PROFIT_TIERS);
  const prices = await fetchPrices(open);

  for (const position of open) {
    if ((position.failures ?? 0) >= MAX_SELL_FAILURES) continue;

    const price = prices.get(position.address.toLowerCase());
    if (!price) continue;

    const decision = decideSell(position, price, tiers, config.STOP_LOSS_PCT);
    if (!decision) continue;

    const multiple = price / position.entryPriceUsd;
    const label =
      `${position.symbol} (${position.address}) on ${position.chain} — ${decision.reason}, ` +
      `entry $${position.entryPriceUsd} now $${price}`;

    if (position.paper || config.DRY_RUN) {
      log.info(
        `DRY RUN: would sell ${(decision.fractionOfOriginal * 100).toFixed(0)}% of ${label}`
      );
      updatePosition(position.chain, position.address, (p) => {
        p.soldFraction = Math.min(1, p.soldFraction + decision.fractionOfOriginal);
        p.hitTiers = [...p.hitTiers, ...decision.tiers];
        if (decision.closeAll || p.soldFraction >= 0.999) {
          p.closed = true;
          p.closedReason = `${decision.reason} (paper) at ${multiple.toFixed(2)}x`;
        }
      });
      continue;
    }

    try {
      const fractionOfHeld = fractionOfHeldBalance(decision, position.soldFraction);
      const tx = await executeSell(position, fractionOfHeld);
      log.info(`SOLD ${(decision.fractionOfOriginal * 100).toFixed(0)}% of ${label} — tx ${tx}`);
      updatePosition(position.chain, position.address, (p) => {
        p.soldFraction = Math.min(1, p.soldFraction + decision.fractionOfOriginal);
        p.hitTiers = [...p.hitTiers, ...decision.tiers];
        p.failures = 0;
        if (decision.closeAll || p.soldFraction >= 0.999) {
          p.closed = true;
          p.closedReason = `${decision.reason} at ${multiple.toFixed(2)}x`;
        }
      });
    } catch (err) {
      updatePosition(position.chain, position.address, (p) => {
        p.failures = (p.failures ?? 0) + 1;
      });
      const failures = (position.failures ?? 0) + 1;
      log.error(`sell failed (${failures}/${MAX_SELL_FAILURES}) for ${label}`, err);
      if (failures >= MAX_SELL_FAILURES) {
        log.warn(
          `giving up on ${position.symbol} (${position.address}) after ${failures} failed sells — ` +
            `it may be a honeypot or need gas on ${position.chain}. Sell it manually; ` +
            `the bot will not retry.`
        );
      }
    }
  }
}

/** True when any exit rule is configured. */
export function sellingEnabled(): boolean {
  return parseTakeProfit(config.TAKE_PROFIT_TIERS).length > 0 || config.STOP_LOSS_PCT > 0;
}

/** Poll open positions forever. Never throws — logs and keeps going. */
export async function startMonitor(): Promise<void> {
  const tiers = parseTakeProfit(config.TAKE_PROFIT_TIERS);
  log.info(
    `position monitor running (every ${config.POSITION_POLL_SECONDS}s, ` +
      `take-profit ${tiers.map((t) => `${t.multiple}x:${t.sellPct}%`).join(",") || "none"}, ` +
      `stop-loss ${config.STOP_LOSS_PCT > 0 ? `-${config.STOP_LOSS_PCT}%` : "off"})`
  );
  for (;;) {
    try {
      await checkPositions();
    } catch (err) {
      log.error("position check failed", err);
    }
    await sleep(config.POSITION_POLL_SECONDS * 1000);
  }
}

/** Re-export for the CLI position report. */
export { loadPositions, positionKey, savePositions };
