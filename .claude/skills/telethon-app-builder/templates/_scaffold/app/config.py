"""Load and validate settings from the environment (.env)."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    """Immutable application settings."""

    api_id: int
    api_hash: str
    session_name: str
    bot_token: str | None = None
    session_string: str | None = None


def load_config() -> Config:
    """Read required settings, failing fast with a clear message if any are missing."""
    try:
        api_id = int(os.environ["API_ID"])
        api_hash = os.environ["API_HASH"]
    except KeyError as exc:
        raise SystemExit(
            f"Missing required env var: {exc}. Copy .env.example to .env and fill it in."
        )
    return Config(
        api_id=api_id,
        api_hash=api_hash,
        session_name=os.getenv("SESSION_NAME", "sessions/account"),
        bot_token=os.getenv("BOT_TOKEN") or None,
        session_string=os.getenv("SESSION_STRING") or None,
    )
