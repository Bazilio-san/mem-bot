"""Default SQLite implementation of Repository.

Uses the stdlib sqlite3. Calls are wrapped in asyncio.to_thread so they don't block the event loop.
For higher write volume, switch to an async driver (aiosqlite) or Postgres behind the same interface.
"""

import asyncio
import json
import sqlite3
from typing import Any

from app.repositories.base import Repository


class SqliteRepository(Repository):
    """Records go into a generic `records(collection, data_json)` table; cursors into `cursors`."""

    def __init__(self, path: str = "data/app.db") -> None:
        self._path = path
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS records (collection TEXT, data_json TEXT)"
        )
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value INTEGER)"
        )
        self._conn.commit()

    async def save(self, collection: str, record: dict[str, Any]) -> None:
        def _write() -> None:
            self._conn.execute(
                "INSERT INTO records (collection, data_json) VALUES (?, ?)",
                (collection, json.dumps(record, ensure_ascii=False, default=str)),
            )
            self._conn.commit()

        await asyncio.to_thread(_write)

    async def get_cursor(self, name: str) -> int:
        def _read() -> int:
            row = self._conn.execute(
                "SELECT value FROM cursors WHERE name = ?", (name,)
            ).fetchone()
            return int(row[0]) if row else 0

        return await asyncio.to_thread(_read)

    async def set_cursor(self, name: str, value: int) -> None:
        def _write() -> None:
            self._conn.execute(
                "INSERT INTO cursors (name, value) VALUES (?, ?) "
                "ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                (name, value),
            )
            self._conn.commit()

        await asyncio.to_thread(_write)
