"""Storage interface. Services depend on this, not on a concrete database."""

from abc import ABC, abstractmethod
from typing import Any


class Repository(ABC):
    """Minimal key/record storage plus a cursor for resumable jobs.

    Swap the implementation (SQLite, Postgres, files) without touching services.
    """

    @abstractmethod
    async def save(self, collection: str, record: dict[str, Any]) -> None:
        """Persist one record into a named collection/table."""

    @abstractmethod
    async def get_cursor(self, name: str) -> int:
        """Return the last saved cursor value for resumable jobs (0 if none)."""

    @abstractmethod
    async def set_cursor(self, name: str, value: int) -> None:
        """Persist a cursor value (e.g. the last processed message id)."""
