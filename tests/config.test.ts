/** Offline tests for config parsing. */
import { describe, expect, test } from "vitest";

import { config } from "../src/config.js";

describe("config", () => {
  test("TELEGRAM_SESSIONS falls back to the single session name", () => {
    // Neither TELEGRAM_SESSIONS nor TELEGRAM_SESSION is set in the test
    // environment, so both fall back to the default.
    expect(config.TELEGRAM_SESSION).toBe("sniper");
    expect(config.TELEGRAM_SESSIONS).toEqual(["sniper"]);
  });
});
