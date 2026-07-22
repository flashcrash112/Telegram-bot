/** Per-chain configuration for the EVM chains we can trade on.
 *
 * Keys match DexScreener's `chainId` values so detection results map
 * straight onto a config. All routers are UniswapV2-compatible, so one
 * ABI covers every chain.
 */
import { rpcUrl } from "./config.js";

export interface EvmChain {
  key: string; // dexscreener chainId
  name: string;
  chainId: number; // EVM network id
  defaultRpc: string;
  router: string; // UniswapV2-style router
  wrappedNative: string;
  nativeSymbol: string;
  eip1559: boolean;
}

/** Effective RPC for a chain: RPC_<KEY> env override or the default. */
export function rpcFor(chain: EvmChain): string {
  return rpcUrl(chain.key, chain.defaultRpc);
}

/** Effective router for a chain: ROUTER_<KEY> env override or the default.
 * The override exists for young chains where the canonical Uniswap V2
 * deployment address may differ from the multichain default.
 */
export function routerFor(chain: EvmChain): string {
  return process.env[`ROUTER_${chain.key.toUpperCase()}`] || chain.router;
}

/** Effective wrapped-native token: WNATIVE_<KEY> env override or the default. */
export function wrappedNativeFor(chain: EvmChain): string {
  return process.env[`WNATIVE_${chain.key.toUpperCase()}`] || chain.wrappedNative;
}

const chainList: EvmChain[] = [
  {
    key: "ethereum", name: "Ethereum", chainId: 1,
    defaultRpc: "https://eth.llamarpc.com",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    nativeSymbol: "ETH", eip1559: true,
  },
  {
    key: "bsc", name: "BNB Chain", chainId: 56,
    defaultRpc: "https://bsc-dataseed.binance.org",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap V2
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEF60aF814a3f6F0Ee75",
    nativeSymbol: "BNB", eip1559: false,
  },
  {
    key: "base", name: "Base", chainId: 8453,
    defaultRpc: "https://mainnet.base.org",
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // Uniswap V2
    wrappedNative: "0x4200000000000000000000000000000000000006",
    nativeSymbol: "ETH", eip1559: true,
  },
  {
    key: "arbitrum", name: "Arbitrum", chainId: 42161,
    defaultRpc: "https://arb1.arbitrum.io/rpc",
    router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    nativeSymbol: "ETH", eip1559: true,
  },
  {
    key: "polygon", name: "Polygon", chainId: 137,
    defaultRpc: "https://polygon-rpc.com",
    router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", // QuickSwap
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    nativeSymbol: "POL", eip1559: true,
  },
  {
    // Arbitrum Orbit L2 by Robinhood, mainnet since 2026-07-01. Uniswap
    // v2 is deployed there; the router below is Uniswap's standard
    // multichain V2Router02 address — run `npm run verify:chain robinhood`
    // against the live RPC before enabling buys, and set ROUTER_ROBINHOOD
    // in .env if the check reports a different router.
    key: "robinhood", name: "Robinhood Chain", chainId: 4663,
    defaultRpc: "https://rpc.mainnet.chain.robinhood.com",
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // Uniswap V2 (multichain address)
    wrappedNative: "0x7943e237c7F95DA44E0301572D358911207852Fa",
    nativeSymbol: "ETH", eip1559: true,
  },
  {
    key: "avalanche", name: "Avalanche", chainId: 43114,
    defaultRpc: "https://api.avax.network/ext/bc/C/rpc",
    router: "0x60aE616a2155Ee3d9A68541Ba4544862310933d4", // Trader Joe
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    nativeSymbol: "AVAX", eip1559: true,
  },
];

export const EVM_CHAINS: Record<string, EvmChain> = Object.fromEntries(
  chainList.map((c) => [c.key, c])
);

export const SOLANA_KEY = "solana";
export const SOLANA_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

// Order used when probing RPCs for bytecode to resolve an EVM address
// whose chain DexScreener doesn't know.
export const EVM_PROBE_ORDER = [
  "ethereum",
  "bsc",
  "base",
  "arbitrum",
  "polygon",
  "robinhood",
  "avalanche",
];
