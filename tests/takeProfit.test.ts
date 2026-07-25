/** Offline tests for take-profit / stop-loss decisions. */
import { describe, expect, test } from "vitest";

import {
  decideSell, fractionOfHeldBalance, parseTakeProfit,
} from "../src/takeProfit.js";

const LADDER = parseTakeProfit("2:50,5:30,10:20");
const fresh = (entry = 1) => ({ entryPriceUsd: entry, soldFraction: 0, hitTiers: [] as number[] });

describe("parseTakeProfit", () => {
  test("parses and sorts a ladder", () => {
    const tiers = parseTakeProfit("5:30,2:50");
    expect(tiers).toEqual([
      { multiple: 2, sellPct: 50 },
      { multiple: 5, sellPct: 30 },
    ]);
  });

  test("empty spec disables take-profit", () => {
    expect(parseTakeProfit("")).toEqual([]);
  });

  test("rejects malformed, <=1x, and over-100% ladders", () => {
    expect(() => parseTakeProfit("abc")).toThrow(/invalid TAKE_PROFIT_TIERS/);
    expect(() => parseTakeProfit("1:50")).toThrow(/greater than 1/);
    expect(() => parseTakeProfit("2:80,3:80")).toThrow(/must not exceed 100/);
  });
});

describe("decideSell", () => {
  test("holds below the first trigger", () => {
    expect(decideSell(fresh(), 1.99, LADDER, 0)).toBeNull();
  });

  test("sells the first tier at 2x", () => {
    const d = decideSell(fresh(), 2, LADDER, 0)!;
    expect(d.fractionOfOriginal).toBeCloseTo(0.5);
    expect(d.tiers).toEqual([2]);
    expect(d.closeAll).toBe(false);
  });

  test("does not re-sell a tier already hit", () => {
    const pos = { entryPriceUsd: 1, soldFraction: 0.5, hitTiers: [2] };
    expect(decideSell(pos, 2.5, LADDER, 0)).toBeNull();
  });

  test("a gap up consumes every tier passed at once", () => {
    const d = decideSell(fresh(), 12, LADDER, 0)!;
    expect(d.fractionOfOriginal).toBeCloseTo(1);
    expect(d.tiers).toEqual([2, 5, 10]);
    expect(d.closeAll).toBe(true);
  });

  test("never sells more than what remains", () => {
    const pos = { entryPriceUsd: 1, soldFraction: 0.9, hitTiers: [2] };
    const d = decideSell(pos, 12, LADDER, 0)!;
    expect(d.fractionOfOriginal).toBeCloseTo(0.1);
    expect(d.closeAll).toBe(true);
  });

  test("stop-loss closes everything and beats the ladder", () => {
    const d = decideSell(fresh(), 0.4, LADDER, 50)!;
    expect(d.closeAll).toBe(true);
    expect(d.fractionOfOriginal).toBeCloseTo(1);
    expect(d.reason).toMatch(/stop-loss/);
  });

  test("stop-loss does not fire above the threshold", () => {
    expect(decideSell(fresh(), 0.6, LADDER, 50)).toBeNull();
  });

  test("fully sold or priceless positions are ignored", () => {
    expect(decideSell({ entryPriceUsd: 1, soldFraction: 1, hitTiers: [] }, 5, LADDER, 0)).toBeNull();
    expect(decideSell(fresh(), 0, LADDER, 0)).toBeNull();
    expect(decideSell({ entryPriceUsd: 0, soldFraction: 0, hitTiers: [] }, 5, LADDER, 0)).toBeNull();
  });

  test("stop-loss alone works with no ladder", () => {
    const d = decideSell(fresh(), 0.2, [], 50)!;
    expect(d.closeAll).toBe(true);
  });
});

describe("fractionOfHeldBalance", () => {
  test("first sale: fraction of original equals fraction of holdings", () => {
    expect(fractionOfHeldBalance({ fractionOfOriginal: 0.5, tiers: [2], reason: "", closeAll: false }, 0))
      .toBeCloseTo(0.5);
  });

  test("second sale scales up against the smaller remaining balance", () => {
    // 30% of the original, with 50% already sold, is 60% of what is held.
    expect(fractionOfHeldBalance({ fractionOfOriginal: 0.3, tiers: [5], reason: "", closeAll: false }, 0.5))
      .toBeCloseTo(0.6);
  });

  test("a closing sale never exceeds the whole balance", () => {
    expect(fractionOfHeldBalance({ fractionOfOriginal: 0.5, tiers: [], reason: "", closeAll: true }, 0.5))
      .toBeCloseTo(1);
  });
});
