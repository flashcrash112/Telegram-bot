/** Discover a chain's real wrapped-native and UniswapV2 router addresses
 * by asking the chain itself, then print the .env lines to use.
 *
 * Run: npm run discover:chain <chain-key> [pairAddress]
 *
 * How it works:
 *   1. Find a live UniswapV2-style pair on the chain — either the one you
 *      pass in, or the deepest pair DexScreener knows for the chain.
 *   2. Read factory(), token0() and token1() straight off the pair
 *      contract on-chain; the wrapped-native side is identified via
 *      DexScreener's quote token (or a WETH-like symbol).
 *   3. Search the chain's Blockscout explorer for verified router
 *      contracts and keep the ones whose factory() matches the pair's
 *      factory and whose WETH() matches the wrapped native.
 *
 * The result is printed as WNATIVE_<KEY>= and ROUTER_<KEY>= lines ready
 * for .env. Always run `npm run verify:chain <key>` afterwards.
 */
import { Contract, JsonRpcProvider, getAddress } from "ethers";

import { EVM_CHAINS, rpcFor } from "./chains.js";

// Blockscout instances per chain key (only needed for router discovery).
const BLOCKSCOUT: Record<string, string> = {
  robinhood: "https://robinhoodchain.blockscout.com",
};

const PAIR_ABI = [
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
];
const ERC20_ABI = ["function symbol() view returns (string)"];

async function json(url: string): Promise<any> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  return resp.json();
}

async function main(): Promise<void> {
  const key = (process.argv[2] ?? "").toLowerCase();
  const chain = EVM_CHAINS[key];
  if (!chain) {
    console.error("usage: npm run discover:chain <chain-key> [pairAddress]");
    console.error(`known chains: ${Object.keys(EVM_CHAINS).sort().join(", ")}`);
    process.exit(2);
  }
  const provider = new JsonRpcProvider(rpcFor(chain), chain.chainId, { staticNetwork: true });

  // ---- 1. find a pair and (if possible) DexScreener's quote token ----
  let pairAddress = process.argv[3] ?? "";
  let quoteFromDex = "";
  if (pairAddress) {
    const data = await json(
      `https://api.dexscreener.com/latest/dex/pairs/${chain.key}/${pairAddress}`
    ).catch(() => null);
    quoteFromDex = data?.pairs?.[0]?.quoteToken?.address ?? "";
  } else {
    console.log(`No pair given — asking DexScreener for the deepest '${chain.key}' pair...`);
    const data = await json(`https://api.dexscreener.com/latest/dex/search?q=${chain.key}`);
    const pairs = (data?.pairs ?? []).filter((p: any) => p?.chainId === chain.key);
    if (!pairs.length) {
      console.error(
        `DexScreener returned no '${chain.key}' pairs; pass a pair address explicitly:\n` +
          `  npm run discover:chain ${chain.key} 0x<pairAddress>\n` +
          `(copy one from https://dexscreener.com/${chain.key})`
      );
      process.exit(1);
    }
    const best = pairs.reduce((a: any, b: any) =>
      (b?.liquidity?.usd ?? 0) > (a?.liquidity?.usd ?? 0) ? b : a
    );
    pairAddress = best.pairAddress;
    quoteFromDex = best?.quoteToken?.address ?? "";
    console.log(
      `Using pair ${pairAddress} (${best?.baseToken?.symbol}/${best?.quoteToken?.symbol}, ` +
        `liquidity $${Math.round(best?.liquidity?.usd ?? 0)}, dex ${best?.dexId})`
    );
  }

  // ---- 2. read the pair on-chain ----
  const pair = new Contract(getAddress(pairAddress), PAIR_ABI, provider);
  const [factory, token0, token1] = await Promise.all([
    pair.factory().catch(() => null),
    pair.token0().catch(() => null),
    pair.token1().catch(() => null),
  ]);
  if (!factory || !token0 || !token1) {
    console.error(
      "Could not read factory()/token0()/token1() from the pair — it may not be a " +
        "UniswapV2-style pool (V3/V4 pools need a different buyer). Try another pair."
    );
    process.exit(1);
  }
  console.log(`pair.factory(): ${factory}`);

  const sym = async (addr: string) =>
    new Contract(addr, ERC20_ABI, provider).symbol().catch(() => "?");
  const [sym0, sym1] = await Promise.all([sym(token0), sym(token1)]);
  console.log(`pair tokens: ${token0} (${sym0}) / ${token1} (${sym1})`);

  let wnative = "";
  if (quoteFromDex) {
    wnative = [token0, token1].find((t) => t.toLowerCase() === quoteFromDex.toLowerCase()) ?? "";
  }
  if (!wnative) {
    wnative =
      [token0, token1].find((t, i) => /^W(ETH|BNB|POL|AVAX)$/i.test([sym0, sym1][i])) ?? "";
  }
  if (!wnative) {
    console.error(
      "Could not identify the wrapped-native side of the pair — pick a pair quoted " +
        "in WETH and re-run with its address."
    );
    process.exit(1);
  }

  // ---- 3. find a router that matches factory + wrapped native ----
  const matches: { address: string; name: string }[] = [];
  const tested = new Set<string>();
  const testCandidate = async (addr: string | undefined, name: string): Promise<void> => {
    if (!addr || tested.has(addr.toLowerCase())) return;
    tested.add(addr.toLowerCase());
    const router = new Contract(addr, ROUTER_ABI, provider);
    const [rFactory, rWeth] = await Promise.all([
      router.factory().catch(() => null),
      router.WETH().catch(() => null),
    ]);
    if (
      rFactory?.toLowerCase() === factory.toLowerCase() &&
      rWeth?.toLowerCase() === wnative.toLowerCase()
    ) {
      matches.push({ address: addr, name });
    }
  };

  const explorer = BLOCKSCOUT[chain.key];
  if (explorer) {
    // 3a. verified contracts whose name looks like a V2 router
    for (const q of ["UniswapV2Router02", "V2Router", "Router02"]) {
      const data = await json(`${explorer}/api/v2/search?q=${q}`).catch(() => null);
      for (const item of data?.items ?? []) {
        if (item?.type !== "contract") continue;
        await testCandidate(item?.address ?? item?.address_hash, item?.name ?? q);
      }
    }
    // 3b. fallback: whoever actually executes swaps against the pair.
    // Swap transactions are sent TO a router, which then calls the pair —
    // so the routers show up as tx targets and internal-tx callers.
    if (!matches.length) {
      console.log("No verified router by name — scanning the pair's recent transactions...");
      const [txs, itxs] = await Promise.all([
        json(`${explorer}/api/v2/addresses/${pairAddress}/transactions`).catch(() => null),
        json(`${explorer}/api/v2/addresses/${pairAddress}/internal-transactions`).catch(() => null),
      ]);
      const candidates: string[] = [];
      for (const item of txs?.items ?? []) candidates.push(item?.to?.hash);
      for (const item of itxs?.items ?? []) candidates.push(item?.from?.hash, item?.to?.hash);
      for (const addr of candidates.filter(Boolean).slice(0, 60)) {
        await testCandidate(addr, "found via pair swap traffic");
      }
    }
  } else {
    console.log(`(no Blockscout URL configured for '${chain.key}' — skipping router search)`);
  }

  // ---- results ----
  console.log();
  console.log("Add to /root/Telegram-bot/.env:");
  console.log(`WNATIVE_${chain.key.toUpperCase()}=${wnative}`);
  if (matches.length) {
    for (const m of matches) console.log(`ROUTER_${chain.key.toUpperCase()}=${m.address}  # ${m.name}`);
    if (matches.length > 1) console.log("# (multiple matches — use the first, it was found first)");
  } else {
    console.log(
      `# No verified V2 router found automatically. Look up the UniswapV2Router02\n` +
        `# for factory ${factory} on the explorer and set ROUTER_${chain.key.toUpperCase()}=<address>`
    );
  }
  console.log();
  console.log(`Then run: npm run verify:chain ${chain.key}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
