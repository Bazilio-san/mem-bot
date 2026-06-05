"""Handler registration.

Handlers stay thin and receive their dependencies (services, repository) via closures, so they are easy to
test and never reach for globals. Each recipe adds its own handler factory and registers it here (or in
main.py). This base version registers a trivial /ping so the scaffold runs on its own.
"""

from telethon import TelegramClient, events


def register_handlers(client: TelegramClient, deps: dict) -> None:
    """Attach all event handlers to the client. `deps` carries services/repositories."""

    @client.on(events.NewMessage(pattern=r"^/ping$"))
    async def _ping(event):
        await event.reply("pong")

    # Recipes register more handlers here, e.g.:
    #   client.add_event_handler(make_autoreply(deps["reply_service"]), events.NewMessage(incoming=True))
