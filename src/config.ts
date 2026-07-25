/** Environment-driven configuration.
 *
 * Settings load from .env; secrets (private keys, API hash) belong in
 * .env.secrets so that opening or screenshotting .env never exposes
 * them. Both files use the same KEY=value format; .env wins on
 * duplicates, so keep each key in exactly one file.
 */
import { config as loadEnv } from "dotenv";

loadEnv();
loadEnv({ path: ".env.secrets" });

function boolEnv(name: string, def: boolean): boolean {
  const raw = (process.env[name] ?? String(def)).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function floatEnv(name: string, def: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? v : def;
}

// Exported as a mutable object so tests can override individual fields.
export const config = {
  TELEGRAM_API_ID: parseInt(process.env.TELEGRAM_API_ID ?? "0", 10) || 0,
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH ?? "",
  TELEGRAM_SESSION: process.env.TELEGRAM_SESSION ?? "sniper",

  // One listener account per session name (comma-separated). Each name is
  // a session-store folder; unknown ones trigger an interactive login on
  // the next foreground run. Falls back to the single TELEGRAM_SESSION.
  TELEGRAM_SESSIONS: (process.env.TELEGRAM_SESSIONS ?? process.env.TELEGRAM_SESSION ?? "sniper")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  TARGET_CHATS: (process.env.TARGET_CHATS ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),

  DRY_RUN: boolEnv("DRY_RUN", true),
  MIN_LIQUIDITY_USD: floatEnv("MIN_LIQUIDITY_USD", 5000),
  ALLOW_UNLISTED: boolEnv("ALLOW_UNLISTED", false),
  SLIPPAGE_BPS: Math.trunc(floatEnv("SLIPPAGE_BPS", 300)),

  EVM_PRIVATE_KEY: (process.env.EVM_PRIVATE_KEY ?? "").trim(),
  SOLANA_PRIVATE_KEY: (process.env.SOLANA_PRIVATE_KEY ?? "").trim(),

  // "native" = swap on each chain's own DEX router (needs gas coins everywhere).
  // "relay"  = fund one origin chain and buy cross-chain via relay.link.
  BUY_ENGINE: (process.env.BUY_ENGINE ?? "native").trim().toLowerCase(),
  RELAY_ORIGIN_CHAIN: (process.env.RELAY_ORIGIN_CHAIN ?? "base").trim().toLowerCase(),
  RELAY_BUY_AMOUNT: floatEnv("RELAY_BUY_AMOUNT", 0),
  // Solana address that receives SPL tokens on cross-chain buys; falls back
  // to the pubkey derived from SOLANA_PRIVATE_KEY.
  SOLANA_RECIPIENT: (process.env.SOLANA_RECIPIENT ?? "").trim(),

  SEEN_TOKENS_FILE: process.env.SEEN_TOKENS_FILE ?? "seen_tokens.json",

  // Log every message the bot receives (chat + first chars). Handy when
  // verifying the bot actually sees a chat; turn off for normal running.
  DEBUG_LOG_MESSAGES: boolEnv("DEBUG_LOG_MESSAGES", false),

  // Chains to act on, e.g. "ethereum,solana". Empty = all supported chains.
  // Detections on other chains are logged but never bought, and EVM RPC
  // probing is limited to the enabled chains.
  ENABLED_CHAINS: (process.env.ENABLED_CHAINS ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean),
};

/** Native-coin buy amount for a chain, e.g. buyAmount('bsc') -> BUY_AMOUNT_BSC. */
export function buyAmount(chainKey: string): number {
  return floatEnv(`BUY_AMOUNT_${chainKey.toUpperCase()}`, 0);
}

export function rpcUrl(chainKey: string, def: string): string {
  return process.env[`RPC_${chainKey.toUpperCase()}`] || def;
}
