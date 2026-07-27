"""Shared detection + buy pipeline used by every message source
(Telegram, Discord, ...). A source just calls `process_text(text, source)`
whenever a new message arrives.
"""
import asyncio
import json
import logging
import os

import config
from sniper import chains, detector, evm_buyer, relay_buyer, solana_buyer

log = logging.getLogger("trader")


class Trader:
    def __init__(self) -> None:
        self.seen: set[str] = self._load_seen()
        self._lock = asyncio.Lock()

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

    async def process_text(self, text: str, source: str) -> None:
        """Detect any token addresses in `text` and buy the new ones.

        `source` is a human label for logs, e.g. "telegram:AlphaDAO" or
        "discord:#calls".
        """
        if not text:
            return
        try:
            detections = await detector.detect(text)
        except Exception:
            log.exception("detection failed for message from %s: %.120s", source, text)
            return

        for det in detections:
            key = f"{det.chain}:{det.address.lower()}"
            # Serialize the check-and-mark so Telegram and Discord can't both
            # fire a buy for the same token at once.
            async with self._lock:
                if key in self.seen:
                    log.info("already processed %s on %s, skipping", det.address, det.chain)
                    continue
                self.seen.add(key)
                self._save_seen()

            log.info(
                "detected %s (%s) on %s | liquidity $%.0f | price %s | dex %s | from %s",
                det.symbol, det.address, det.chain, det.liquidity_usd,
                det.price_usd, det.dex, source,
            )
            await self.buy(det)

    async def buy(self, det: detector.Detection) -> None:
        # ---- safety gates ----
        if config.ENABLED_CHAINS and det.chain not in config.ENABLED_CHAINS:
            log.info(
                "%s is on %s, which is not in ENABLED_CHAINS=%s — skipping",
                det.address, det.chain, ",".join(config.ENABLED_CHAINS),
            )
            return
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
