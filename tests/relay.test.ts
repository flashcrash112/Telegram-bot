/** Offline tests for Relay quote construction (no network calls). */
import { afterEach, describe, expect, test } from "vitest";

import { config } from "../src/config.js";
import {
  NATIVE_EVM,
  RELAY_SOLANA_CHAIN_ID,
  buildQuoteBody,
  destinationChainId,
  toInt,
} from "../src/relaySwap.js";

const USER = "0x000000000000000000000000000000000000dEaD";
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const saved = {
  SOLANA_RECIPIENT: config.SOLANA_RECIPIENT,
  SOLANA_PRIVATE_KEY: config.SOLANA_PRIVATE_KEY,
};
afterEach(() => {
  Object.assign(config, saved);
});

describe("relay buyer", () => {
  test("destination chain ids", () => {
    expect(destinationChainId("ethereum")).toBe(1);
    expect(destinationChainId("base")).toBe(8453);
    expect(destinationChainId("solana")).toBe(RELAY_SOLANA_CHAIN_ID);
    expect(destinationChainId("unknown-chain")).toBeNull();
  });

  test("quote body for EVM destination", async () => {
    const body = await buildQuoteBody(USER, "ethereum", PEPE, 10n ** 16n);
    expect(body.user).toBe(USER);
    expect(body.recipient).toBe(USER);
    expect(body.originChainId).toBe(8453); // default origin: base
    expect(body.destinationChainId).toBe(1);
    expect(body.originCurrency).toBe(NATIVE_EVM);
    expect(body.destinationCurrency).toBe(PEPE);
    expect(body.amount).toBe((10n ** 16n).toString());
    expect(body.tradeType).toBe("EXACT_INPUT");
  });

  test("quote body for Solana destination", async () => {
    config.SOLANA_RECIPIENT = BONK; // any valid pubkey string
    const body = await buildQuoteBody(USER, "solana", BONK, 10n ** 16n);
    expect(body.destinationChainId).toBe(RELAY_SOLANA_CHAIN_ID);
    expect(body.recipient).toBe(BONK);
  });

  test("quote body for Solana without recipient fails", async () => {
    config.SOLANA_RECIPIENT = "";
    config.SOLANA_PRIVATE_KEY = "";
    await expect(buildQuoteBody(USER, "solana", BONK, 10n ** 16n)).rejects.toThrow(
      /SOLANA_RECIPIENT/
    );
  });

  test("toInt accepts Relay number formats", () => {
    expect(toInt(null)).toBe(0n);
    expect(toInt(5)).toBe(5n);
    expect(toInt("5")).toBe(5n);
    expect(toInt("0x10")).toBe(16n);
  });
});
