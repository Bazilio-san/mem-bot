# Recipe: voice processing

**Use when:** the app receives voice notes / audio, downloads them, and transcribes (then optionally replies
with text, summarizes, or routes to an LLM). Telethon handles receipt and download; transcription is a
separate service.

> **Cross-link:** do the transcription with the **`assemblyai`** skill (or another STT). This recipe shows the
> Telethon side: detect voice, download, hand off the file. Keep STT keys in `.env`.

## Maps onto the scaffold

- `app/clients/stt.py` — the transcription client (from the assemblyai skill).
- `app/services/transcribe.py` — orchestrates download → STT → result.
- `app/handlers/voice.py` — handler filtered to voice messages.
- Repository: optional transcripts store.

## Detect + download + transcribe

```python
# app/handlers/voice.py
from telethon import events

def make_voice_handler(transcribe):  # transcribe: async (path) -> str
    async def handler(event):
        # Download the voice note to a temp path (returns the saved path).
        path = await event.message.download_media(file="downloads/")
        async with event.client.action(event.chat_id, "typing"):
            text = await transcribe(path)
        await event.reply(f"📝 {text}" if text else "Couldn't transcribe that.")
    return handler

def register(client, transcribe):
    # event.voice is set for voice notes; use event.audio for music/audio files.
    client.add_event_handler(
        make_voice_handler(transcribe),
        events.NewMessage(incoming=True, func=lambda e: e.voice is not None),
    )
```

```python
# app/services/transcribe.py  (STT details live in the assemblyai skill)
def make_transcribe(stt_client):
    async def transcribe(path: str) -> str:
        return await stt_client.transcribe_file(path)   # see assemblyai skill
    return transcribe
```

## Gotchas

- **Filter correctly.** `e.voice` = voice notes (OGG/Opus); `e.audio` = audio files; `e.video_note` = round
  video messages. Pick the ones you handle.
- **Download cost.** Large audio downloads can hit FloodWait — wrap in retry and clean up temp files after.
- **Blocking STT.** If the STT SDK is synchronous, run it via `asyncio.to_thread` so the event loop isn't
  blocked ([../../references/production-practices.md](../../references/production-practices.md)).
- **Format.** Telegram voice notes are OGG/Opus; make sure your STT accepts that or transcode first.
- **Privacy/consent.** Transcribing private voice messages is sensitive — only do it with the users' awareness.
