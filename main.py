"""Telegram contract sniper — entrypoint.

First run asks for your phone number + login code to create the
Telethon session file; after that it starts unattended.
"""
import asyncio
import logging
import sys

import config
from sniper.listener import Sniper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)


def check_config() -> list[str]:
    problems = []
    if not config.TELEGRAM_API_ID or not config.TELEGRAM_API_HASH:
        problems.append("TELEGRAM_API_ID / TELEGRAM_API_HASH are required (https://my.telegram.org)")
    if not config.DRY_RUN and not (config.EVM_PRIVATE_KEY or config.SOLANA_PRIVATE_KEY):
        problems.append("DRY_RUN=false but no EVM_PRIVATE_KEY or SOLANA_PRIVATE_KEY is set")
    return problems


def main() -> None:
    problems = check_config()
    if problems:
        for p in problems:
            print(f"config error: {p}", file=sys.stderr)
        sys.exit(1)

    if config.DRY_RUN:
        print("running in DRY RUN mode — no real transactions will be sent")
    else:
        print("!!! LIVE MODE — detected tokens WILL be bought with real funds !!!")

    try:
        asyncio.run(Sniper().run())
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()
