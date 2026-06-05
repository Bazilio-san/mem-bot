# Messages and media (v1.43.x)

## Sending

```python
await client.send_message(entity, "Hello *world*", parse_mode="md")
await client.send_message(entity, "reply", reply_to=message_id)

# Files / media (path, bytes, or a Telegram file id):
await client.send_file(entity, "report.pdf", caption="Monthly report")
await client.send_file(entity, ["a.jpg", "b.jpg"])      # album
await client.send_file(entity, "note.ogg", voice_note=True)
```

`entity` can be an id, username, phone, or a resolved entity (see
[entities-and-chats.md](entities-and-chats.md)). From inside a handler, prefer `event.respond` / `event.reply`.

## Reading history

```python
# Newest first; limit caps the count. Async iteration handles paging for you.
async for message in client.iter_messages(entity, limit=200):
    print(message.id, message.sender_id, message.text)

# Bounded by id (resume a scraper from the last processed id):
async for message in client.iter_messages(entity, min_id=last_id):
    process(message)

# Search and filters:
async for message in client.iter_messages(entity, search="invoice"):
    ...

# One-shot fetch (returns a list):
messages = await client.get_messages(entity, limit=10)
```

`iter_messages` already paginates and respects rate limits; still wrap long runs in FloodWait handling and
persist the last id (see [errors-and-flood.md](errors-and-flood.md)).

## Downloading media

```python
# To a path or directory:
path = await client.download_media(message, file="downloads/")

# To memory (bytes):
blob = await message.download_media(file=bytes)

# Only when media is present:
if message.media:
    await client.download_media(message, file="downloads/")
```

Detecting media kinds on a message: `message.photo`, `message.video`, `message.voice`, `message.audio`,
`message.document`, `message.gif`. For voice/audio pipelines, `message.voice` / `message.audio` are the ones
you want (see the voice-processing recipe).

## Albums

A multi-photo post arrives either as several `NewMessage` events or, with the `Album` event, as one grouped
event:

```python
from telethon import events

@client.on(events.Album)
async def on_album(event):
    # event.messages is the list of grouped messages
    await event.reply(f"Got an album of {len(event.messages)} items")
```

## Formatting and entities

Pass `parse_mode="md"` or `"html"` to send formatted text. Telethon parses the markup into message entities.
Keep user-provided text un-trusted: if you echo it back inside Markdown/HTML, escape it to avoid broken or
injected formatting.
