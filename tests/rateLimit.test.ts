/** Offline tests for the rolling 24h buy limits. */
import { describe, expect, test } from "vitest";

import { BuyRecord, checkLimits, recent } from "../src/rateLimit.js";

const NOW = Date.parse("2026-07-25T12:00:00Z");
const hoursAgo = (h: number, usd = 50): BuyRecord => ({
  at: new Date(NOW - h * 3600_000).toISOString(),
  usd,
  symbol: "T",
});

describe("rolling window", () => {
  test("keeps only the trailing 24 hours", () => {
    const history = [hoursAgo(1), hoursAgo(23), hoursAgo(25), hoursAgo(48)];
    expect(recent(history, NOW)).toHaveLength(2);
  });

  test("ignores unparseable timestamps", () => {
    expect(recent([{ at: "not-a-date", usd: 1, symbol: "T" }], NOW)).toHaveLength(0);
  });
});

describe("checkLimits", () => {
  test("allows everything when both limits are off", () => {
    const history = Array.from({ length: 50 }, () => hoursAgo(1, 1000));
    expect(checkLimits(history, 500, NOW, 0, 0).allowed).toBe(true);
  });

  test("blocks at the buy count and says when a slot frees up", () => {
    const history = [hoursAgo(5), hoursAgo(4), hoursAgo(3)];
    const verdict = checkLimits(history, 50, NOW, 3, 0);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/daily buy cap reached \(3\/3/);
    expect(verdict.reason).toMatch(/~1140 min/); // oldest was 5h ago -> 19h left
  });

  test("expired buys free the cap again", () => {
    const history = [hoursAgo(30), hoursAgo(26), hoursAgo(25)];
    expect(checkLimits(history, 50, NOW, 3, 0).allowed).toBe(true);
  });

  test("blocks when the spend cap would be exceeded", () => {
    const history = [hoursAgo(2, 120), hoursAgo(1, 100)];
    expect(checkLimits(history, 100, NOW, 0, 300).allowed).toBe(false);
    expect(checkLimits(history, 80, NOW, 0, 300).allowed).toBe(true);
  });

  test("spend cap counts only the trailing window", () => {
    const history = [hoursAgo(30, 1000), hoursAgo(2, 50)];
    expect(checkLimits(history, 100, NOW, 0, 300).allowed).toBe(true);
  });

  test("either limit alone can block", () => {
    const history = [hoursAgo(1, 10), hoursAgo(2, 10)];
    expect(checkLimits(history, 10, NOW, 2, 0).allowed).toBe(false);
    expect(checkLimits(history, 10, NOW, 0, 25).allowed).toBe(false);
    expect(checkLimits(history, 10, NOW, 5, 100).allowed).toBe(true);
  });
});
