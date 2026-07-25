/** Regression tests for native-coin pricing used by tiered sizing.
 *
 * The bug this guards against: deriving the native coin's USD price from
 * a detected token's priceUsd/priceNative ratio. DexScreener denominates
 * priceNative in the PAIR's quote token, so a stablecoin-quoted pool
 * makes that ratio ~1 and inflates every buy by the native coin's price
 * — a $300 buy became 299.7 ETH.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { nativeUsdPrice } from "../src/detector.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockPairs(pairs: unknown[]): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ pairs }), { status: 200 })
  ) as unknown as typeof fetch;
}

const WETH_BASE = "0x4200000000000000000000000000000000000006";
const WETH_ARBITRUM = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const SOL_MINT = "So11111111111111111111111111111111111111112";

describe("nativeUsdPrice", () => {
  test("reads the price directly from a pool where the native coin is the base", async () => {
    mockPairs([
      {
        baseToken: { address: WETH_BASE },
        quoteToken: { address: "0xUSDC" },
        priceUsd: "3712.55",
        priceNative: "1",
        liquidity: { usd: 5_000_000 },
      },
    ]);
    expect(await nativeUsdPrice("base")).toBeCloseTo(3712.55, 2);
  });

  test("derives it from a pool quoted IN the native coin", async () => {
    mockPairs([
      {
        // MEME/WETH: $0.05 per token, 0.00001 WETH per token -> WETH = $5000
        baseToken: { address: "0xMEME" },
        quoteToken: { address: WETH_ARBITRUM },
        priceUsd: "0.05",
        priceNative: "0.00001",
        liquidity: { usd: 900_000 },
      },
    ]);
    expect(await nativeUsdPrice("arbitrum")).toBeCloseTo(5000, 6);
  });

  test("prefers the deepest pool and ignores stablecoin-quoted noise", async () => {
    mockPairs([
      {
        // A shallow, stablecoin-quoted pool that must NOT set the price.
        baseToken: { address: "0xOTHER" },
        quoteToken: { address: "0xUSDC" },
        priceUsd: "1.0002",
        priceNative: "1.0002",
        liquidity: { usd: 10 },
      },
      {
        baseToken: { address: SOL_MINT },
        quoteToken: { address: "0xUSDC" },
        priceUsd: "74.10",
        priceNative: "74.10",
        liquidity: { usd: 12_000_000 },
      },
    ]);
    // 74.10, not 1.0002 — the shallow unrelated pool is ignored.
    expect(await nativeUsdPrice("solana")).toBeCloseTo(74.1, 2);
  });

  test("returns 0 when nothing usable comes back, so sizing falls back", async () => {
    mockPairs([{ baseToken: { address: "0xUNRELATED" }, quoteToken: { address: "0xUSDC" } }]);
    expect(await nativeUsdPrice("polygon")).toBe(0);
  });

  test("returns 0 for an unknown chain without calling the network", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(await nativeUsdPrice("not-a-chain")).toBe(0);
  });
});
