/** Offline tests for the chain registry. */
import { describe, expect, test } from "vitest";

import { config } from "../src/config.js";
import { EVM_CHAINS, EVM_PROBE_ORDER, buyEngineFor, routerFor } from "../src/chains.js";
import { destinationChainId } from "../src/relayBuyer.js";

describe("chain registry", () => {
  test("robinhood chain is registered correctly", () => {
    const chain = EVM_CHAINS.robinhood;
    expect(chain).toBeDefined();
    expect(chain.chainId).toBe(4663);
    expect(chain.nativeSymbol).toBe("ETH");
    expect(chain.eip1559).toBe(true);
    expect(EVM_PROBE_ORDER).toContain("robinhood");
    expect(destinationChainId("robinhood")).toBe(4663);
  });

  test("every probe-order key exists in the registry", () => {
    for (const key of EVM_PROBE_ORDER) {
      expect(EVM_CHAINS[key], key).toBeDefined();
    }
  });

  test("robinhood defaults to the relay engine, others to global", () => {
    expect(config.BUY_ENGINE).toBe("native");
    expect(buyEngineFor("robinhood")).toBe("relay");
    expect(buyEngineFor("ethereum")).toBe("native");
    expect(buyEngineFor("solana")).toBe("native");
    process.env.BUY_ENGINE_ROBINHOOD = "native";
    try {
      expect(buyEngineFor("robinhood")).toBe("native");
    } finally {
      delete process.env.BUY_ENGINE_ROBINHOOD;
    }
  });

  test("ROUTER_<KEY> env override wins over the default", () => {
    const chain = EVM_CHAINS.robinhood;
    expect(routerFor(chain)).toBe(chain.router);
    process.env.ROUTER_ROBINHOOD = "0x000000000000000000000000000000000000dEaD";
    try {
      expect(routerFor(chain)).toBe("0x000000000000000000000000000000000000dEaD");
    } finally {
      delete process.env.ROUTER_ROBINHOOD;
    }
  });
});
