/** Take-profit / stop-loss decision logic (pure, no I/O).
 *
 * TAKE_PROFIT_TIERS is a comma-separated list of `<multiple>:<percent>`
 * entries, e.g. "2:50,5:30,10:20" — at 2x sell 50% of the original
 * position, at 5x another 30%, at 10x the last 20%. Percentages are
 * always of the ORIGINAL position, never of what is left, so a tier
 * table adds up to at most 100.
 *
 * STOP_LOSS_PCT sells everything remaining once the price falls that
 * many percent below entry (e.g. 50 = exit at -50%).
 */

export interface TakeProfitTier {
  multiple: number; // price multiple vs entry that triggers this tier
  sellPct: number; // percent OF THE ORIGINAL position to sell
}

export interface SellDecision {
  /** Fraction (0-1) of the ORIGINAL position to sell now. */
  fractionOfOriginal: number;
  /** Tier multiples consumed by this decision (empty for stop-loss). */
  tiers: number[];
  reason: string;
  /** True when the whole remaining position should go. */
  closeAll: boolean;
}

/** Parse a TAKE_PROFIT_TIERS spec. Throws on malformed input. */
export function parseTakeProfit(spec: string): TakeProfitTier[] {
  const trimmed = spec.trim();
  if (!trimmed) return [];
  const tiers = trimmed.split(",").map((entry) => {
    const m = entry.trim().match(/^(\d+(?:\.\d+)?)[:=](\d+(?:\.\d+)?)$/);
    if (!m) {
      throw new Error(
        `invalid TAKE_PROFIT_TIERS entry '${entry.trim()}' — expected <multiple>:<percent>`
      );
    }
    const tier = { multiple: parseFloat(m[1]), sellPct: parseFloat(m[2]) };
    if (tier.multiple <= 1) {
      throw new Error(
        `invalid TAKE_PROFIT_TIERS entry '${entry.trim()}' — multiple must be greater than 1`
      );
    }
    return tier;
  });
  const total = tiers.reduce((sum, t) => sum + t.sellPct, 0);
  if (total > 100) {
    throw new Error(`TAKE_PROFIT_TIERS sells ${total}% of the position — must not exceed 100%`);
  }
  tiers.sort((a, b) => a.multiple - b.multiple);
  return tiers;
}

export interface PositionState {
  entryPriceUsd: number;
  /** Fraction (0-1) of the original position already sold. */
  soldFraction: number;
  /** Tier multiples already executed. */
  hitTiers: number[];
}

/** Decide whether to sell now, and how much. Returns null to hold. */
export function decideSell(
  pos: PositionState,
  currentPriceUsd: number,
  tiers: TakeProfitTier[],
  stopLossPct: number
): SellDecision | null {
  if (!(currentPriceUsd > 0) || !(pos.entryPriceUsd > 0)) return null;
  const remaining = 1 - pos.soldFraction;
  if (remaining <= 1e-9) return null;

  const multiple = currentPriceUsd / pos.entryPriceUsd;

  if (stopLossPct > 0 && multiple <= 1 - stopLossPct / 100) {
    return {
      fractionOfOriginal: remaining,
      tiers: [],
      reason: `stop-loss at ${(multiple * 100 - 100).toFixed(1)}% (${multiple.toFixed(3)}x)`,
      closeAll: true,
    };
  }

  const due = tiers.filter((t) => multiple >= t.multiple && !pos.hitTiers.includes(t.multiple));
  if (!due.length) return null;

  const wanted = due.reduce((sum, t) => sum + t.sellPct, 0) / 100;
  const fraction = Math.min(wanted, remaining);
  if (fraction <= 1e-9) return null;

  return {
    fractionOfOriginal: fraction,
    tiers: due.map((t) => t.multiple),
    reason: `take-profit ${due.map((t) => `${t.multiple}x`).join("+")} at ${multiple.toFixed(2)}x`,
    closeAll: fraction >= remaining - 1e-9,
  };
}

/** Convert "sell X of the original" into "sell Y of what is held now". */
export function fractionOfHeldBalance(decision: SellDecision, soldFraction: number): number {
  const remaining = 1 - soldFraction;
  if (remaining <= 1e-9) return 0;
  return Math.min(1, decision.fractionOfOriginal / remaining);
}
