/** Telegram listener: watches configured chats, extracts contract
 * addresses from every new message, and hands them to the buyer.
 */
import fs from "node:fs";
import readline from "node:readline/promises";

import { TelegramClient } from "telegram";
import { StoreSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";

import { config, buyAmount } from "./config.js";
import { EVM_CHAINS, SOLANA_KEY, buyEngineFor } from "./chains.js";
import * as detector from "./detector.js";
import * as evmBuyer from "./evmBuyer.js";
import * as relayBuyer from "./relayBuyer.js";
import * as solanaBuyer from "./solanaBuyer.js";
import { makeLog } from "./log.js";

const log = makeLog("listener");

export class Sniper {
  private clients: { name: string; client: TelegramClient }[];
  private seen: Set<string>;

  constructor() {
    // One listening account per configured session. All accounts feed the
    // same pipeline and share the seen-tokens dedupe, so a token posted in
    // several watched chats (or seen by several accounts) is bought once.
    this.clients = config.TELEGRAM_SESSIONS.map((name) => ({
      name,
      client: new TelegramClient(
        new StoreSession(name),
        config.TELEGRAM_API_ID,
        config.TELEGRAM_API_HASH,
        { connectionRetries: 5 }
      ),
    }));
    this.seen = this.loadSeen();
  }

  // ---------- dedupe persistence ----------

  private loadSeen(): Set<string> {
    if (fs.existsSync(config.SEEN_TOKENS_FILE)) {
      try {
        return new Set(JSON.parse(fs.readFileSync(config.SEEN_TOKENS_FILE, "utf8")));
      } catch {
        log.warn(`could not read ${config.SEEN_TOKENS_FILE}, starting fresh`);
      }
    }
    return new Set();
  }

  private saveSeen(): void {
    fs.writeFileSync(config.SEEN_TOKENS_FILE, JSON.stringify([...this.seen].sort()));
  }

  // ---------- pipeline ----------

  async handleMessage(event: NewMessageEvent): Promise<void> {
    const text = event.message?.message ?? "";
    let chatName: string | undefined;
    const describeChat = async () => {
      if (chatName === undefined) {
        const chat: any = await event.message.getChat().catch(() => null);
        chatName = chat?.title || chat?.username || String(event.chatId ?? "?");
      }
      return chatName;
    };

    if (config.DEBUG_LOG_MESSAGES) {
      const chat = await describeChat();
      log.info(`message from '${chat}' (id ${event.chatId}): ${JSON.stringify(text.slice(0, 80))}`);
    }
    if (!text) return;

    let detections: detector.Detection[];
    try {
      detections = await detector.detect(text);
    } catch (err) {
      log.error(`detection failed for message: ${text.slice(0, 120)}`, err);
      return;
    }

    for (const det of detections) {
      const key = `${det.chain}:${det.address.toLowerCase()}`;
      if (this.seen.has(key)) {
        log.info(`already processed ${det.address} on ${det.chain}, skipping`);
        continue;
      }
      this.seen.add(key);
      this.saveSeen();

      const chat = await describeChat();
      log.info(
        `detected ${det.symbol} (${det.address}) on ${det.chain} | ` +
          `liquidity $${Math.round(det.liquidityUsd)} | price ${det.priceUsd} | ` +
          `dex ${det.dex} | from chat '${chat}'`
      );
      await this.buy(det);
    }
  }

  async buy(det: detector.Detection): Promise<void> {
    // ---- safety gates ----
    if (config.ENABLED_CHAINS.length && !config.ENABLED_CHAINS.includes(det.chain)) {
      log.info(
        `${det.address} is on ${det.chain}, which is not in ` +
          `ENABLED_CHAINS=${config.ENABLED_CHAINS.join(",")} — skipping`
      );
      return;
    }
    if (!det.listed && !config.ALLOW_UNLISTED) {
      log.warn(
        `${det.address} on ${det.chain} is not listed on DexScreener and ALLOW_UNLISTED=false — skipping`
      );
      return;
    }
    if (det.listed && det.liquidityUsd < config.MIN_LIQUIDITY_USD) {
      log.warn(
        `${det.symbol} liquidity $${Math.round(det.liquidityUsd)} is below ` +
          `MIN_LIQUIDITY_USD=${config.MIN_LIQUIDITY_USD} — skipping`
      );
      return;
    }

    const useRelay = buyEngineFor(det.chain) === "relay";
    const amount = useRelay ? config.RELAY_BUY_AMOUNT : buyAmount(det.chain);
    if (amount <= 0) {
      const varName = useRelay ? "RELAY_BUY_AMOUNT" : `BUY_AMOUNT_${det.chain.toUpperCase()}`;
      log.warn(`no buy amount configured (${varName}) for chain '${det.chain}' — skipping`);
      return;
    }

    const isSolana = det.chain === SOLANA_KEY;
    const evmChain = EVM_CHAINS[det.chain];
    if (!isSolana && !evmChain) {
      log.warn(`chain '${det.chain}' detected but not supported for buying — skipping`);
      return;
    }

    if (config.DRY_RUN) {
      const origin = useRelay ? ` (paid from ${config.RELAY_ORIGIN_CHAIN} via Relay)` : "";
      log.info(
        `DRY RUN: would buy ${amount} worth of ${det.symbol} (${det.address}) on ${det.chain}${origin}`
      );
      return;
    }

    try {
      if (useRelay) {
        const tx = await relayBuyer.buy(det.chain, det.address, amount);
        log.info(`BOUGHT ${det.symbol} on ${det.chain} via Relay — origin tx ${tx}`);
      } else if (isSolana) {
        const sig = await solanaBuyer.buy(det.address, amount);
        log.info(`BOUGHT ${det.symbol} on Solana — https://solscan.io/tx/${sig}`);
      } else {
        const tx = await evmBuyer.buy(evmChain, det.address, amount);
        log.info(`BOUGHT ${det.symbol} on ${evmChain.name} — tx ${tx}`);
      }
    } catch (err) {
      log.error(`buy failed for ${det.address} on ${det.chain}`, err);
    }
  }

  // ---------- entrypoint ----------

  async run(): Promise<void> {
    // Accept numeric IDs alongside @usernames. The same list applies to
    // every account; numeric IDs simply never match for an account that
    // is not in that chat.
    const target = config.TARGET_CHATS.map((t) =>
      /^-?\d+$/.test(t) ? Number(t) : t
    );

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    for (const { name, client } of this.clients) {
      await client.start({
        phoneNumber: () => rl.question(`[${name}] Phone number (international format): `),
        password: () => rl.question(`[${name}] 2FA password: `),
        phoneCode: () => rl.question(`[${name}] Login code you received: `),
        onError: async (err) => {
          log.error(`[${name}] login error`, err);
          return true;
        },
      });
      const me: any = await client.getMe();
      log.info(`[${name}] logged in as ${me.username || me.firstName}`);

      client.addEventHandler(
        (event: NewMessageEvent) => this.handleMessage(event),
        new NewMessage(target.length ? { chats: target } : {})
      );
    }
    rl.close();

    if (target.length) {
      log.info(`listening to ${target.length} chat(s): [${target.join(", ")}]`);
    } else {
      log.warn("TARGET_CHATS is empty — listening to ALL chats on these accounts");
    }
    log.info(
      `sniper running (${this.clients.length} account(s), ` +
        `dry_run=${config.DRY_RUN ? "True" : "False"}, ` +
        `min_liquidity=$${config.MIN_LIQUIDITY_USD})`
    );
    await new Promise(() => {}); // run until the process is stopped
  }
}
