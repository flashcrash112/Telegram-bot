/** Rolling 24-hour spending limits.
 *
 * MAX_BUYS_PER_DAY caps how many buys can fire in any 24-hour window;
 * MAX_SPEND_PER_DAY_USD caps their total sized value. Both are 0 by
 * default (no limit). The window is rolling, not calendar-day, so a
 * burst of calls cannot reset itself at midnight.
 *
 * Dry-run buys count too: paper results should reflect what would
 * really have happened, limits included.
 */
import fs from "node:fs";

import { config } from "./config.js";

export interface BuyRecord {
  at: string; // ISO timestamp
  usd: number; // sized value when known, else 0
  symbol: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadHistory(): BuyRecord[] {
  if (!fs.existsSync(config.BUY_HISTORY_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(config.BUY_HISTORY_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Records inside the trailing 24 hours from `now`. */
export function recent(history: BuyRecord[], now: number): BuyRecord[] {
  return history.filter((r) => {
    const at = Date.parse(r.at);
    return Number.isFinite(at) && now - at < DAY_MS;
  });
}

export interface LimitVerdict {
  allowed: boolean;
  reason?: string;
}

/** Would one more buy of `usd` breach a limit right now? */
export function checkLimits(
  history: BuyRecord[],
  usd: number,
  now: number,
  maxBuys: number,
  maxSpendUsd: number
): LimitVerdict {
  const window = recent(history, now);

  if (maxBuys > 0 && window.length >= maxBuys) {
    const oldest = Math.min(...window.map((r) => Date.parse(r.at)));
    const freesIn = Math.ceil((oldest + DAY_MS - now) / 60_000);
    return {
      allowed: false,
      reason:
        `daily buy cap reached (${window.length}/${maxBuys} in the last 24h) — ` +
        `next slot frees up in ~${freesIn} min`,
    };
  }

  if (maxSpendUsd > 0) {
    const spent = window.reduce((sum, r) => sum + (r.usd || 0), 0);
    if (spent + usd > maxSpendUsd) {
      return {
        allowed: false,
        reason:
          `daily spend cap reached ($${Math.round(spent)} spent + $${Math.round(usd)} ` +
          `would exceed MAX_SPEND_PER_DAY_USD=${maxSpendUsd})`,
      };
    }
  }

  return { allowed: true };
}

/** Append a buy and prune records older than the window. */
export function recordBuy(record: BuyRecord, now: number): void {
  const history = [...recent(loadHistory(), now), record];
  fs.writeFileSync(config.BUY_HISTORY_FILE, JSON.stringify(history, null, 2));
}
