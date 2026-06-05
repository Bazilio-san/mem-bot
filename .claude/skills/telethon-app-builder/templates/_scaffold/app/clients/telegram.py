"""The single TelegramClient factory. Nothing else in the app constructs a client."""

from telethon import TelegramClient
from telethon.sessions import StringSession

from app.config import Config


def build_client(config: Config) -> TelegramClient:
    """Create a TelegramClient from config.

    Uses a portable StringSession when SESSION_STRING is set (good for containers/CI),
    otherwise an on-disk SQLite session at SESSION_NAME.
    """
    session = StringSession(config.session_string) if config.session_string else config.session_name
    client = TelegramClient(session, config.api_id, config.api_hash)
    # Auto-sleep flood waits up to 60s; longer ones raise FloodWaitError for us to handle.
    client.flood_sleep_threshold = 60
    return client


async def start_client(client: TelegramClient, config: Config) -> TelegramClient:
    """Sign in. Bot login when BOT_TOKEN is set, otherwise interactive user login (first run only)."""
    if config.bot_token:
        await client.start(bot_token=config.bot_token)
    else:
        await client.start()  # prompts for phone + code (+ 2FA password) on first run
    return client
