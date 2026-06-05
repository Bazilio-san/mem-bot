#!/usr/bin/env python3
"""Smallest working Telethon userbot — verify credentials and session before building anything bigger.

Setup:
    pip install telethon python-dotenv
    # .env with API_ID and API_HASH from https://my.telegram.org/apps
    python minimal_userbot.py

First run prompts for phone + login code (+ 2FA password if set), then reuses the session file.
Send "/ping" to the account (e.g. from Saved Messages) and it replies "pong".
"""

import asyncio
import os

from dotenv import load_dotenv
from telethon import TelegramClient, events

load_dotenv()

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
SESSION = os.getenv("SESSION_NAME", "sessions/account")


async def main() -> None:
    client = TelegramClient(SESSION, API_ID, API_HASH)

    @client.on(events.NewMessage(pattern=r"^/ping$"))
    async def _ping(event):
        await event.reply("pong")

    async with client:
        await client.start()  # interactive on first run
        me = await client.get_me()
        print(f"Logged in as {me.first_name} (@{me.username}). Listening… Ctrl+C to stop.")
        await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
