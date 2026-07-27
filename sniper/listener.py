"""Telegram listener: watches configured chats and feeds every new
message into the shared Trader pipeline.
"""
import logging

from telethon import TelegramClient, events

import config
from sniper.trader import Trader

log = logging.getLogger("telegram")


class TelegramListener:
    def __init__(self, trader: Trader) -> None:
        self.trader = trader
        self.client = TelegramClient(
            config.TELEGRAM_SESSION, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH
        )

    async def handle_message(self, event: events.NewMessage.Event) -> None:
        text = event.raw_text or ""
        chat = getattr(event.chat, "title", None) or getattr(event.chat, "username", event.chat_id)
        if config.DEBUG_LOG_MESSAGES:
            log.info("message from %r (id %s): %.80r", chat, event.chat_id, text)
        await self.trader.process_text(text, f"telegram:{chat}")

    async def run(self) -> None:
        await self.client.start()
        me = await self.client.get_me()
        log.info("logged in as %s", me.username or me.first_name)

        target = config.TARGET_CHATS or None
        if target:
            target = [int(t) if t.lstrip("-").isdigit() else t for t in target]
            log.info("listening to %d chat(s): %s", len(target), target)
        else:
            log.warning("TARGET_CHATS is empty — listening to ALL chats on this account")

        self.client.add_event_handler(self.handle_message, events.NewMessage(chats=target))
        log.info("telegram listener running")
        await self.client.run_until_disconnected()
