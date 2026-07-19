"""Print every chat this Telegram account can see, with the ID to use
in TARGET_CHATS. Run: .venv/bin/python list_chats.py
"""
from telethon.sync import TelegramClient

import config

with TelegramClient(
    config.TELEGRAM_SESSION, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH
) as client:
    print(f"{'ID':>15}  NAME")
    print("-" * 60)
    for dialog in client.iter_dialogs():
        kind = "channel" if dialog.is_channel else "group" if dialog.is_group else "dm"
        print(f"{dialog.id:>15}  [{kind}] {dialog.name}")
