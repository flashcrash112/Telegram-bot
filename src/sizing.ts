/** Market-cap-tiered buy sizing.
 *
 * BUY_TIERS_USD is a comma-separated list of `<maxMarketCap>:<usd>`
 * entries plus a final `default:<usd>` for anything above the last cap,
 * e.g.:
 *
 *   BUY_TIERS_USD=50000:50,100000:100,200000:150,500000:200,1000000:250,default:300
 *
 * means: under $50k mcap buy $50, $50k-100k buy $100, ... above $1m buy
 * $300. When set, tier sizing replaces the fixed BUY_AMOUNT_<CHAIN> /
 * RELAY_BUY_AMOUNT for tokens whose market cap and native price are
 * known; otherwise the fixed amounts are used as a fallback.
 */

export interface Tier {
  maxCap: number; // upper market-cap bound (exclusive); Infinity for default
  usd: number;
}

/** Parse a BUY_TIERS_USD spec. Throws on malformed entries. */
export function parseTiers(spec: string): Tier[] {
  const trimmed = spec.trim();
  if (!trimmed) return [];
  const tiers = trimmed.split(",").map((entry) => {
    const m = entry.trim().match(/^(default|\d+(?:\.\d+)?)[:=](\d+(?:\.\d+)?)$/i);
    if (!m) {
      throw new Error(
        `invalid BUY_TIERS_USD entry '${entry.trim()}' — expected <maxMarketCap>:<usd> or default:<usd>`
      );
    }
    return {
      maxCap: m[1].toLowerCase() === "default" ? Infinity : parseFloat(m[1]),
      usd: parseFloat(m[2]),
    };
  });
  tiers.sort((a, b) => a.maxCap - b.maxCap);
  return tiers;
}

/** USD buy size for a market cap, or null if no tier covers it. */
export function tierAmountUsd(tiers: Tier[], marketCap: number): number | null {
  for (const tier of tiers) {
    if (marketCap < tier.maxCap) return tier.usd;
  }
  return null;
}
