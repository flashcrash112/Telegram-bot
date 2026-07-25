/** Print tracked positions with their current multiple.
 * Run: npm run positions          (open positions)
 *      npm run positions -- all   (including closed ones)
 */
import { fetchPrices } from "./monitor.js";
import { loadPositions } from "./positions.js";

async function main(): Promise<void> {
  const showAll = (process.argv[2] ?? "").toLowerCase() === "all";
  const positions = loadPositions().filter((p) => showAll || !p.closed);
  if (!positions.length) {
    console.log(showAll ? "no positions recorded" : "no open positions");
    process.exit(0);
  }

  const prices = await fetchPrices(positions);
  console.log(
    ["SYMBOL".padEnd(10), "CHAIN".padEnd(10), "ENTRY$".padEnd(14), "NOW$".padEnd(14),
      "MULT".padEnd(8), "SOLD".padEnd(6), "KIND".padEnd(6), "STATUS"].join(" ")
  );
  console.log("-".repeat(96));

  for (const p of positions) {
    const price = prices.get(p.address.toLowerCase());
    const multiple = price && p.entryPriceUsd > 0 ? price / p.entryPriceUsd : null;
    console.log(
      [
        p.symbol.slice(0, 10).padEnd(10),
        p.chain.slice(0, 10).padEnd(10),
        String(p.entryPriceUsd).slice(0, 13).padEnd(14),
        (price ? String(price).slice(0, 13) : "?").padEnd(14),
        (multiple ? `${multiple.toFixed(2)}x` : "?").padEnd(8),
        `${Math.round(p.soldFraction * 100)}%`.padEnd(6),
        (p.paper ? "paper" : "real").padEnd(6),
        p.closed ? `closed: ${p.closedReason ?? ""}` : `open${p.failures ? ` (${p.failures} sell failures)` : ""}`,
      ].join(" ")
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
