/** Telegram contract sniper — entrypoint.
 *
 * First run asks for your phone number + login code to create the
 * Telegram session; after that it starts unattended.
 */
import { config } from "./config.js";
import { EVM_CHAINS } from "./chains.js";
import { Sniper } from "./listener.js";
import { parseTiers } from "./sizing.js";
import { parseTakeProfit } from "./takeProfit.js";
import { sellingEnabled, startMonitor } from "./monitor.js";

function checkConfig(): string[] {
  const problems: string[] = [];
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH) {
    problems.push("TELEGRAM_API_ID / TELEGRAM_API_HASH are required (https://my.telegram.org)");
  }
  if (!config.DRY_RUN && !config.EVM_PRIVATE_KEY && !config.SOLANA_PRIVATE_KEY) {
    problems.push("DRY_RUN=false but no EVM_PRIVATE_KEY or SOLANA_PRIVATE_KEY is set");
  }
  try {
    parseTiers(config.BUY_TIERS_USD);
  } catch (err) {
    problems.push((err as Error).message);
  }
  try {
    parseTakeProfit(config.TAKE_PROFIT_TIERS);
  } catch (err) {
    problems.push((err as Error).message);
  }
  if (config.STOP_LOSS_PCT < 0 || config.STOP_LOSS_PCT >= 100) {
    problems.push(`STOP_LOSS_PCT must be between 0 and 100, got ${config.STOP_LOSS_PCT}`);
  }
  if (!["native", "relay"].includes(config.BUY_ENGINE)) {
    problems.push(`BUY_ENGINE must be 'native' or 'relay', got '${config.BUY_ENGINE}'`);
  }
  if (config.BUY_ENGINE === "relay") {
    if (!(config.RELAY_ORIGIN_CHAIN in EVM_CHAINS)) {
      problems.push(
        `RELAY_ORIGIN_CHAIN must be one of [${Object.keys(EVM_CHAINS).sort().join(", ")}], ` +
          `got '${config.RELAY_ORIGIN_CHAIN}'`
      );
    }
    if (!config.DRY_RUN && !config.EVM_PRIVATE_KEY) {
      problems.push("BUY_ENGINE=relay needs EVM_PRIVATE_KEY (the origin wallet)");
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const problems = checkConfig();
  if (problems.length) {
    for (const p of problems) console.error(`config error: ${p}`);
    process.exit(1);
  }

  if (config.DRY_RUN) {
    console.log("running in DRY RUN mode — no real transactions will be sent");
  } else {
    console.log("!!! LIVE MODE — detected tokens WILL be bought with real funds !!!");
  }

  process.on("SIGINT", () => {
    console.log("stopped");
    process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));

  // The monitor runs alongside the listener: one watches chats, the
  // other watches the positions those chats produced.
  if (sellingEnabled()) startMonitor();

  await new Sniper().run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
