"""Telegram + Discord contract sniper — entrypoint.

Runs every enabled message source concurrently, all feeding one shared
detection/buy pipeline. First Telegram run asks for phone + login code to
create the session file; after that it starts unattended.
"""
import asyncio
import logging
import sys

import config
from sniper.trader import Trader

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)


def check_config() -> list[str]:
    problems = []
    if not (config.ENABLE_TELEGRAM or config.ENABLE_DISCORD):
        problems.append("no source enabled — set ENABLE_TELEGRAM=true and/or ENABLE_DISCORD=true")
    if config.ENABLE_TELEGRAM and not (config.TELEGRAM_API_ID and config.TELEGRAM_API_HASH):
        problems.append("ENABLE_TELEGRAM=true but TELEGRAM_API_ID / TELEGRAM_API_HASH are missing")
    if config.ENABLE_DISCORD and config.DISCORD_MODE not in ("bot", "user"):
        problems.append(f"DISCORD_MODE must be 'bot' or 'user', got {config.DISCORD_MODE!r}")
    if not config.DRY_RUN and not (config.EVM_PRIVATE_KEY or config.SOLANA_PRIVATE_KEY):
        problems.append("DRY_RUN=false but no EVM_PRIVATE_KEY or SOLANA_PRIVATE_KEY is set")
    if config.BUY_ENGINE not in ("native", "relay"):
        problems.append(f"BUY_ENGINE must be 'native' or 'relay', got {config.BUY_ENGINE!r}")
    if config.BUY_ENGINE == "relay":
        from sniper.chains import EVM_CHAINS

        if config.RELAY_ORIGIN_CHAIN not in EVM_CHAINS:
            problems.append(
                f"RELAY_ORIGIN_CHAIN must be one of {sorted(EVM_CHAINS)}, got {config.RELAY_ORIGIN_CHAIN!r}"
            )
        if not config.DRY_RUN and not config.EVM_PRIVATE_KEY:
            problems.append("BUY_ENGINE=relay needs EVM_PRIVATE_KEY (the origin wallet)")
    return problems


async def run() -> None:
    trader = Trader()
    tasks = []

    if config.ENABLE_TELEGRAM:
        from sniper.listener import TelegramListener

        tasks.append(asyncio.create_task(TelegramListener(trader).run(), name="telegram"))

    if config.ENABLE_DISCORD:
        from sniper.discord_listener import DiscordListener

        tasks.append(asyncio.create_task(DiscordListener(trader).run(), name="discord"))

    await asyncio.gather(*tasks)


def main() -> None:
    problems = check_config()
    if problems:
        for p in problems:
            print(f"config error: {p}", file=sys.stderr)
        sys.exit(1)

    sources = []
    if config.ENABLE_TELEGRAM:
        sources.append("Telegram")
    if config.ENABLE_DISCORD:
        sources.append(f"Discord({config.DISCORD_MODE})")
    print(f"sources: {', '.join(sources)}")

    if config.DRY_RUN:
        print("running in DRY RUN mode — no real transactions will be sent")
    else:
        print("!!! LIVE MODE — detected tokens WILL be bought with real funds !!!")

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()
