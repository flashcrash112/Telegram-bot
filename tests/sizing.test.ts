/** Offline tests for market-cap-tiered buy sizing. */
import { describe, expect, test } from "vitest";

import { parseTiers, tierAmountUsd } from "../src/sizing.js";

const SPEC = "50000:50,100000:100,200000:150,500000:200,1000000:250,default:300";

describe("BUY_TIERS_USD", () => {
  test("parses the full tier table", () => {
    const tiers = parseTiers(SPEC);
    expect(tiers).toHaveLength(6);
    expect(tiers[0]).toEqual({ maxCap: 50000, usd: 50 });
    expect(tiers[5]).toEqual({ maxCap: Infinity, usd: 300 });
  });

  test("picks the right tier per market cap", () => {
    const tiers = parseTiers(SPEC);
    expect(tierAmountUsd(tiers, 0)).toBe(50);
    expect(tierAmountUsd(tiers, 49_999)).toBe(50);
    expect(tierAmountUsd(tiers, 50_000)).toBe(100); // boundary goes up
    expect(tierAmountUsd(tiers, 150_000)).toBe(150);
    expect(tierAmountUsd(tiers, 350_000)).toBe(200);
    expect(tierAmountUsd(tiers, 999_999)).toBe(250);
    expect(tierAmountUsd(tiers, 1_000_000)).toBe(300);
    expect(tierAmountUsd(tiers, 50_000_000)).toBe(300);
  });

  test("unsorted spec still resolves correctly", () => {
    const tiers = parseTiers("default:300,50000:50,1000000:250");
    expect(tierAmountUsd(tiers, 10_000)).toBe(50);
    expect(tierAmountUsd(tiers, 500_000)).toBe(250);
    expect(tierAmountUsd(tiers, 2_000_000)).toBe(300);
  });

  test("no default tier -> null above the top cap", () => {
    const tiers = parseTiers("50000:50");
    expect(tierAmountUsd(tiers, 100_000)).toBeNull();
  });

  test("empty spec disables tiering", () => {
    expect(parseTiers("")).toEqual([]);
    expect(parseTiers("   ")).toEqual([]);
  });

  test("malformed entries throw", () => {
    expect(() => parseTiers("abc")).toThrow(/invalid BUY_TIERS_USD/);
    expect(() => parseTiers("50k:50")).toThrow(/invalid BUY_TIERS_USD/);
    expect(() => parseTiers("50000:50,oops")).toThrow(/invalid BUY_TIERS_USD/);
  });
});
