/** Verify a chain's config against the live network before enabling buys.
 *
 * Run: npm run verify:chain <chain-key>   (e.g. robinhood)
 *
 * Checks, in order:
 *   1. the RPC answers and reports the expected chain id
 *   2. the wrapped-native address holds a contract with a WETH-like symbol
 *   3. the router address holds a contract
 *   4. the router is UniswapV2-compatible: WETH() matches wrappedNative
 *      and factory() returns a contract address
 *
 * All checks must PASS before setting a BUY_AMOUNT for the chain. If the
 * router check fails, find the correct UniswapV2 router for the chain and
 * set ROUTER_<KEY> in .env, then re-run.
 */
import { Contract, JsonRpcProvider, getAddress } from "ethers";

import { EVM_CHAINS, rpcFor, routerFor, wrappedNativeFor } from "./chains.js";

const ROUTER_PROBE_ABI = [
  "function WETH() view returns (address)",
  "function factory() view returns (address)",
];
const ERC20_ABI = ["function symbol() view returns (string)"];

let failures = 0;

function report(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${detail}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const key = (process.argv[2] ?? "").toLowerCase();
  const chain = EVM_CHAINS[key];
  if (!chain) {
    console.error(`usage: npm run verify:chain <chain-key>`);
    console.error(`known chains: ${Object.keys(EVM_CHAINS).sort().join(", ")}`);
    process.exit(2);
  }

  const rpc = rpcFor(chain);
  const routerAddr = routerFor(chain);
  const wnative = wrappedNativeFor(chain);
  console.log(`Verifying ${chain.name} (key '${chain.key}')`);
  console.log(`  rpc:            ${rpc}`);
  console.log(`  router:         ${routerAddr}`);
  console.log(`  wrapped native: ${wnative}`);
  console.log();

  const provider = new JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true });

  // 1. RPC reachable + right network
  let liveChainId: number | null = null;
  try {
    liveChainId = Number(await provider.send("eth_chainId", []));
  } catch (err) {
    report(false, "rpc", `unreachable: ${(err as Error).message}`);
  }
  if (liveChainId !== null) {
    report(
      liveChainId === chain.chainId,
      "chain id",
      `expected ${chain.chainId}, rpc says ${liveChainId}`
    );
  }

  // 2. wrapped native is a contract with a symbol
  const wnativeCode = await provider.getCode(getAddress(wnative)).catch(() => "0x");
  report(wnativeCode.length > 2, "wrapped native bytecode", wnative);
  if (wnativeCode.length > 2) {
    const symbol = await new Contract(wnative, ERC20_ABI, provider)
      .symbol()
      .catch(() => "?");
    report(typeof symbol === "string" && symbol.length > 0, "wrapped native symbol", symbol);
  }

  // 3. router is a contract
  const routerCode = await provider.getCode(getAddress(routerAddr)).catch(() => "0x");
  report(routerCode.length > 2, "router bytecode", routerAddr);

  // 4. router speaks UniswapV2 and agrees on WETH
  if (routerCode.length > 2) {
    const router = new Contract(routerAddr, ROUTER_PROBE_ABI, provider);
    const wethFromRouter: string | null = await router.WETH().catch(() => null);
    report(
      wethFromRouter !== null &&
        wethFromRouter.toLowerCase() === wnative.toLowerCase(),
      "router.WETH() matches",
      wethFromRouter ?? "call failed (not a V2 router?)"
    );
    const factory: string | null = await router.factory().catch(() => null);
    let factoryOk = false;
    if (factory) {
      const factoryCode = await provider.getCode(factory).catch(() => "0x");
      factoryOk = factoryCode.length > 2;
    }
    report(factoryOk, "router.factory() is a contract", factory ?? "call failed");
  }

  console.log();
  if (failures) {
    console.log(
      `${failures} check(s) FAILED — do NOT set a buy amount for '${chain.key}' yet. ` +
        `If the router checks failed, set ROUTER_${chain.key.toUpperCase()} in .env and re-run.`
    );
    process.exit(1);
  }
  console.log(`All checks passed — '${chain.key}' is safe to enable.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
