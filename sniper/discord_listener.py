"""Discord listener.

Two modes, chosen by DISCORD_MODE:
  - "bot"  : official Discord bot (DISCORD_BOT_TOKEN). Safe, but only sees
             servers/channels the bot has been invited to.
  - "user" : logs in with a user account token (DISCORD_USER_TOKEN). Can read
             any server the account is in, INCLUDING call servers, but this
             is a Discord ToS violation and can get the account banned.

Both use the discord.py-self fork, which supports user tokens as well as
bot tokens. Only messages from channels listed in DISCORD_CHANNELS (by
numeric channel ID) are processed; empty = every channel the account sees.
"""
import logging

import config
from sniper.trader import Trader

log = logging.getLogger("discord")


class DiscordListener:
    def __init__(self, trader: Trader) -> None:
        self.trader = trader

    async def run(self) -> None:
        try:
            import discord
        except ImportError:
            log.error(
                "discord.py-self is not installed. Run: "
                ".venv/bin/pip install 'discord.py-self>=2.0'"
            )
            return

        is_user = config.DISCORD_MODE == "user"
        token = config.DISCORD_USER_TOKEN if is_user else config.DISCORD_BOT_TOKEN
        if not token:
            log.error(
                "DISCORD_MODE=%s but %s is not set — Discord disabled",
                config.DISCORD_MODE,
                "DISCORD_USER_TOKEN" if is_user else "DISCORD_BOT_TOKEN",
            )
            return

        allowed = set(config.DISCORD_CHANNELS)
        trader = self.trader

        # discord.py-self accepts bot tokens too; a user token just omits the
        # bot-only intents machinery.
        client = discord.Client()

        @client.event
        async def on_ready() -> None:
            who = getattr(client.user, "name", "?")
            if allowed:
                log.info("logged in as %s | watching %d channel(s): %s", who, len(allowed), sorted(allowed))
            else:
                log.warning("logged in as %s | DISCORD_CHANNELS empty — watching ALL channels", who)

        @client.event
        async def on_message(message) -> None:
            if allowed and message.channel.id not in allowed:
                return
            channel = getattr(message.channel, "name", message.channel.id)
            if config.DEBUG_LOG_MESSAGES:
                log.info("message in #%s (id %s): %.80r", channel, message.channel.id, message.content)
            await trader.process_text(message.content, f"discord:#{channel}")

        if is_user:
            log.warning(
                "running Discord in USER-TOKEN mode — this violates Discord ToS "
                "and risks an account ban"
            )
        await client.start(token)
