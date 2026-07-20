/** Offline tests for the ENABLED_CHAINS filter. */
import { afterEach, describe, expect, test } from "vitest";

import { config } from "../src/config.js";
import { EVM_PROBE_ORDER } from "../src/chains.js";
import { probeTargets, solanaEnabled } from "../src/detector.js";

const original = [...config.ENABLED_CHAINS];
afterEach(() => {
  config.ENABLED_CHAINS = [...original];
});

describe("ENABLED_CHAINS filter", () => {
  test("empty means all chains", () => {
    config.ENABLED_CHAINS = [];
    expect(probeTargets()).toEqual(EVM_PROBE_ORDER);
    expect(solanaEnabled()).toBe(true);
  });

  test("ethereum and solana only", () => {
    config.ENABLED_CHAINS = ["ethereum", "solana"];
    expect(probeTargets()).toEqual(["ethereum"]);
    expect(solanaEnabled()).toBe(true);
  });

  test("EVM only disables solana", () => {
    config.ENABLED_CHAINS = ["bsc", "base"];
    expect(probeTargets()).toEqual(["bsc", "base"]);
    expect(solanaEnabled()).toBe(false);
  });
});
