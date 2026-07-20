/** Offline tests for address extraction (no network calls). */
import { describe, expect, test } from "vitest";

import { extractCandidates } from "../src/detector.js";

describe("extractCandidates", () => {
  test("extracts EVM address", () => {
    const text = "New gem! CA: 0x6982508145454Ce325dDbE47a25d4ec3d2311933 100x soon";
    const [evm, sol] = extractCandidates(text);
    expect(evm).toEqual(["0x6982508145454Ce325dDbE47a25d4ec3d2311933"]);
    expect(sol).toEqual([]);
  });

  test("extracts Solana mint", () => {
    const text = "ape this: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const [evm, sol] = extractCandidates(text);
    expect(evm).toEqual([]);
    expect(sol).toEqual(["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"]);
  });

  test("ignores wrapped SOL and stables", () => {
    const text =
      "pair vs So11111111111111111111111111111111111111112 and EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const [evm, sol] = extractCandidates(text);
    expect(evm).toEqual([]);
    expect(sol).toEqual([]);
  });

  test("ignores random words and short hex", () => {
    const text = "just chatting about 0x1234 and BullishAF today, no contracts here";
    const [evm, sol] = extractCandidates(text);
    expect(evm).toEqual([]);
    expect(sol).toEqual([]);
  });

  test("dedupes repeated address", () => {
    const addr = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
    const [evm] = extractCandidates(`${addr} again ${addr}`);
    expect(evm).toEqual([addr]);
  });

  test("multiple addresses in one message", () => {
    const text =
      "ETH: 0x6982508145454Ce325dDbE47a25d4ec3d2311933 " +
      "SOL: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const [evm, sol] = extractCandidates(text);
    expect(evm).toHaveLength(1);
    expect(sol).toHaveLength(1);
  });
});
