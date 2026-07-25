/** Extract contract addresses from message text and figure out which
 * blockchain each one lives on.
 *
 * Chain detection strategy:
 * 1. Address shape narrows it down: 0x + 40 hex chars = some EVM chain,
 *    32-44 base58 chars = Solana candidate.
 * 2. DexScreener's token endpoint is asked which chain(s) the token has
 *    trading pairs on; the pair with the deepest liquidity wins. This also
 *    yields symbol/liquidity data used for safety checks.
 * 3. If DexScreener has never seen the token (brand-new launch), EVM
 *    addresses are resolved by probing each chain's RPC for contract
 *    bytecode; Solana candidates are checked against the Solana RPC.
 */
import bs58 from "bs58";

import { config, rpcUrl } from "./config.js";
import {
  EVM_CHAINS, EVM_PROBE_ORDER, SOLANA_DEFAULT_RPC, SOLANA_KEY, rpcFor, wrappedNativeFor,
} from "./chains.js";
import { makeLog } from "./log.js";

const log = makeLog("detector");

const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/g;
// Base58 (no 0, O, I, l), typical Solana pubkey length.
const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

const DEXSCREENER_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens/";

// Frequent base58-looking strings that are not token mints.
const SOLANA_IGNORE = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export interface Detection {
  address: string;
  chain: string; // dexscreener-style chain key, e.g. "ethereum", "solana"
  symbol: string;
  name: string;
  liquidityUsd: number;
  marketCap: number; // USD market cap (or FDV fallback); 0 if unknown
  priceUsd: string;
  priceNative: string; // token price in the chain's native coin; "?" if unknown
  dex: string;
  listed: boolean; // known to DexScreener
}

function detection(partial: Partial<Detection> & Pick<Detection, "address" | "chain">): Detection {
  return {
    symbol: "?",
    name: "?",
    liquidityUsd: 0,
    marketCap: 0,
    priceUsd: "?",
    priceNative: "?",
    dex: "?",
    listed: false,
    ...partial,
  };
}

/** Return [evmCandidates, solanaCandidates] found in text. */
export function extractCandidates(text: string): [string[], string[]] {
  const evm = [...new Set([...text.matchAll(EVM_RE)].map((m) => m[0]))];
  const sol: string[] = [];
  for (const m of text.matchAll(SOLANA_RE)) {
    const s = m[0];
    if (SOLANA_IGNORE.has(s) || sol.includes(s)) continue;
    // Must decode to exactly 32 bytes to be a Solana pubkey.
    try {
      if (bs58.decode(s).length === 32) sol.push(s);
    } catch {
      continue;
    }
  }
  return [evm, sol];
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; data: any } | null> {
  try {
    const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: resp.status, data: await resp.json().catch(() => ({})) };
  } catch {
    return null;
  }
}

/** Ask DexScreener which chain the token trades on; pick the deepest pool. */
async function dexscreenerLookup(address: string): Promise<Detection | null> {
  const resp = await fetchJson(DEXSCREENER_TOKEN_URL + address, {}, 8000);
  if (!resp) {
    log.warn(`DexScreener lookup failed for ${address}`);
    return null;
  }
  if (resp.status !== 200) return null;

  let pairs: any[] = resp.data?.pairs ?? [];
  // Only pairs where this address is the traded token, not the quote side.
  pairs = pairs.filter(
    (p) => (p?.baseToken?.address ?? "").toLowerCase() === address.toLowerCase()
  );
  if (!pairs.length) return null;

  const liq = (p: any) => p?.liquidity?.usd ?? 0;
  const best = pairs.reduce((a, b) => (liq(b) > liq(a) ? b : a));
  const baseToken = best?.baseToken ?? {};
  return detection({
    address: baseToken.address ?? address,
    chain: best?.chainId ?? "",
    symbol: baseToken.symbol ?? "?",
    name: baseToken.name ?? "?",
    liquidityUsd: liq(best),
    marketCap: best?.marketCap ?? best?.fdv ?? 0,
    priceUsd: best?.priceUsd ?? "?",
    priceNative: best?.priceNative ?? "?",
    dex: best?.dexId ?? "?",
    listed: true,
  });
}

/** True if the address has contract bytecode on this chain. */
async function probeEvmChain(rpc: string, address: string): Promise<boolean> {
  const resp = await fetchJson(
    rpc,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"],
      }),
    },
    6000
  );
  if (!resp || resp.status !== 200) return false;
  const result = resp.data?.result ?? "0x";
  return typeof result === "string" && result.length > 2;
}

/** EVM chains to probe for bytecode, respecting ENABLED_CHAINS. */
export function probeTargets(): string[] {
  if (config.ENABLED_CHAINS.length) {
    return EVM_PROBE_ORDER.filter((k) => config.ENABLED_CHAINS.includes(k));
  }
  return [...EVM_PROBE_ORDER];
}

export function solanaEnabled(): boolean {
  return !config.ENABLED_CHAINS.length || config.ENABLED_CHAINS.includes(SOLANA_KEY);
}

/** True if the address is an SPL token mint on Solana. */
async function probeSolana(address: string): Promise<boolean> {
  const rpc = rpcUrl("solana", SOLANA_DEFAULT_RPC);
  const resp = await fetchJson(
    rpc,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [address, { encoding: "jsonParsed" }],
      }),
    },
    6000
  );
  if (!resp || resp.status !== 200) return false;
  const value = resp.data?.result?.value;
  if (!value) return false;
  // SPL Token / Token-2022 program owns all mints.
  return [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ].includes(value?.owner ?? "");
}

// The native coin's USD price, cached briefly. Sizing must never infer
// it from a detected token's priceUsd/priceNative ratio: DexScreener's
// priceNative is denominated in the PAIR's quote token, which is often
// a stablecoin, and treating that as the native coin inflates buy
// amounts by the native coin's USD price (e.g. $300 -> 300 ETH).
const nativePriceCache = new Map<string, { usd: number; at: number }>();
const NATIVE_PRICE_TTL_MS = 60_000;

export async function nativeUsdPrice(chainKey: string): Promise<number> {
  const cached = nativePriceCache.get(chainKey);
  if (cached && Date.now() - cached.at < NATIVE_PRICE_TTL_MS) return cached.usd;

  let nativeAddress: string;
  if (chainKey === SOLANA_KEY) {
    nativeAddress = "So11111111111111111111111111111111111111112";
  } else {
    const chain = EVM_CHAINS[chainKey];
    if (!chain) return 0;
    nativeAddress = wrappedNativeFor(chain);
  }

  const resp = await fetchJson(DEXSCREENER_TOKEN_URL + nativeAddress, {}, 8000);
  if (!resp || resp.status !== 200) return 0;

  const pairs: any[] = (resp.data?.pairs ?? [])
    .slice()
    .sort((a: any, b: any) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));

  for (const pair of pairs) {
    const base = (pair?.baseToken?.address ?? "").toLowerCase();
    const quote = (pair?.quoteToken?.address ?? "").toLowerCase();
    const target = nativeAddress.toLowerCase();
    // The native coin priced directly (e.g. a WETH/USDC pool).
    if (base === target) {
      const usd = parseFloat(pair?.priceUsd ?? "");
      if (usd > 0) {
        nativePriceCache.set(chainKey, { usd, at: Date.now() });
        return usd;
      }
    }
    // Or a pool QUOTED in the native coin: the other token's USD price
    // divided by its native-denominated price is the native coin's price.
    if (quote === target) {
      const priceUsd = parseFloat(pair?.priceUsd ?? "");
      const priceNative = parseFloat(pair?.priceNative ?? "");
      if (priceUsd > 0 && priceNative > 0) {
        const usd = priceUsd / priceNative;
        nativePriceCache.set(chainKey, { usd, at: Date.now() });
        return usd;
      }
    }
  }
  return 0;
}

/** Find every tradable token address in `text` with its chain resolved. */
export async function detect(text: string): Promise<Detection[]> {
  const [evmCandidates, solCandidates] = extractCandidates(text);
  if (!evmCandidates.length && !solCandidates.length) return [];

  const detections: Detection[] = [];
  for (const address of [...evmCandidates, ...solCandidates]) {
    const det = await dexscreenerLookup(address);
    if (det) {
      detections.push(det);
      continue;
    }

    // Unknown to DexScreener — resolve chain the hard way.
    if (evmCandidates.includes(address)) {
      let found = false;
      for (const key of probeTargets()) {
        const chain = EVM_CHAINS[key];
        if (await probeEvmChain(rpcFor(chain), address)) {
          detections.push(detection({ address, chain: key }));
          found = true;
          break;
        }
      }
      if (!found) {
        log.info(`EVM address ${address} has no bytecode on any enabled chain; skipping`);
      }
    } else if (solanaEnabled() && (await probeSolana(address))) {
      detections.push(detection({ address, chain: SOLANA_KEY }));
    }
  }
  return detections;
}
