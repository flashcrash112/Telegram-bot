"""Telegram listener: watches configured chats, extracts contract
addresses from every new message, and hands them to the buyer.
"""
import asyncio
import json
import logging
import os

from telethon import TelegramClient, events

import config
from sniper import chains, detector, evm_buyer, relay_buyer, solana_buyer

log = logging.getLogger("listener")


class Sniper:
    def __init__(self) -> None:
        self.client = TelegramClient(
            config.TELEGRAM_SESSION, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH
        )
        self.seen: set[str] = self._load_seen()

    # ---------- dedupe persistence ----------

    def _load_seen(self) -> set[str]:
        if os.path.exists(config.SEEN_TOKENS_FILE):
            try:
                with open(config.SEEN_TOKENS_FILE) as f:
                    return set(json.load(f))
            except (json.JSONDecodeError, OSError):
                log.warning("could not read %s, starting fresh", config.SEEN_TOKENS_FILE)
        return set()

    def _save_seen(self) -> None:
        with open(config.SEEN_TOKENS_FILE, "w") as f:
            json.dump(sorted(self.seen), f)

    # ---------- pipeline ----------

    async def handle_message(self, event: events.NewMessage.Event) -> None:
        text = event.raw_text or ""
        if not text:
            return
        try:
            detections = await detector.detect(text)
        except Exception:
            log.exception("detection failed for message: %.120s", text)
            return

        for det in detections:
            key = f"{det.chain}:{det.address.lower()}"
            if key in self.seen:
                log.info("already processed %s on %s, skipping", det.address, det.chain)
                continue
            self.seen.add(key)
            self._save_seen()

            chat = getattr(event.chat, "title", None) or getattr(event.chat, "username", event.chat_id)
            log.info(
                "detected %s (%s) on %s | liquidity $%.0f | price %s | dex %s | from chat %r",
                det.symbol, det.address, det.chain, det.liquidity_usd, det.price_usd, det.dex, chat,
            )
            await self.buy(det)

    async def buy(self, det: detector.Detection) -> None:
        # ---- safety gates ----
        if not det.listed and not config.ALLOW_UNLISTED:
            log.warning(
                "%s on %s is not listed on DexScreener and ALLOW_UNLISTED=false — skipping",
                det.address, det.chain,
            )
            return
        if det.listed and det.liquidity_usd < config.MIN_LIQUIDITY_USD:
            log.warning(
                "%s liquidity $%.0f is below MIN_LIQUIDITY_USD=%.0f — skipping",
                det.symbol, det.liquidity_usd, config.MIN_LIQUIDITY_USD,
            )
            return

        use_relay = config.BUY_ENGINE == "relay"
        amount = config.RELAY_BUY_AMOUNT if use_relay else config.buy_amount(det.chain)
        if amount <= 0:
            log.warning(
                "no buy amount configured (%s) for chain %r — skipping",
                "RELAY_BUY_AMOUNT" if use_relay else f"BUY_AMOUNT_{det.chain.upper()}",
                det.chain,
            )
            return

        is_solana = det.chain == chains.SOLANA_KEY
        evm_chain = chains.EVM_CHAINS.get(det.chain)
        if not is_solana and evm_chain is None:
            log.warning("chain %r detected but not supported for buying — skipping", det.chain)
            return

        if config.DRY_RUN:
            origin = f" (paid from {config.RELAY_ORIGIN_CHAIN} via Relay)" if use_relay else ""
            log.info(
                "DRY RUN: would buy %s worth of %s (%s) on %s%s",
                amount, det.symbol, det.address, det.chain, origin,
            )
            return

        try:
            if use_relay:
                tx = await relay_buyer.buy(det.chain, det.address, amount)
                log.info("BOUGHT %s on %s via Relay — origin tx %s", det.symbol, det.chain, tx)
            elif is_solana:
                sig = await solana_buyer.buy(det.address, amount)
                log.info("BOUGHT %s on Solana — https://solscan.io/tx/%s", det.symbol, sig)
            else:
                # web3.py is sync; keep the event loop responsive.
                tx = await asyncio.to_thread(evm_buyer.buy, evm_chain, det.address, amount)
                log.info("BOUGHT %s on %s — tx %s", det.symbol, evm_chain.name, tx)
        except Exception:
            log.exception("buy failed for %s on %s", det.address, det.chain)

    # ---------- entrypoint ----------

    async def run(self) -> None:
        await self.client.start()
        me = await self.client.get_me()
        log.info("logged in as %s", me.username or me.first_name)

        target = config.TARGET_CHATS or None
        if target:
            # Accept numeric IDs alongside @usernames.
            target = [int(t) if t.lstrip("-").isdigit() else t for t in target]
            log.info("listening to %d chat(s): %s", len(target), target)
        else:
            log.warning("TARGET_CHATS is empty — listening to ALL chats on this account")

        self.client.add_event_handler(self.handle_message, events.NewMessage(chats=target))
        log.info("sniper running (dry_run=%s, min_liquidity=$%.0f)", config.DRY_RUN, config.MIN_LIQUIDITY_USD)
        await self.client.run_until_disconnected()
