"""Composition root: load config, build the client and dependencies, register handlers, run.

This is the only place that knows how everything is wired together. Run with:  python main.py
"""

import asyncio
import logging

from app.clients.telegram import build_client, start_client
from app.config import load_config
from app.handlers import register_handlers
from app.repositories.sqlite import SqliteRepository


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


async def main() -> None:
    configure_logging()
    config = load_config()

    client = build_client(config)
    deps = {"repo": SqliteRepository()}  # recipes add their services here

    async with client:
        await start_client(client, config)
        register_handlers(client, deps)
        logging.getLogger(__name__).info("Client started; listening for events.")
        await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
