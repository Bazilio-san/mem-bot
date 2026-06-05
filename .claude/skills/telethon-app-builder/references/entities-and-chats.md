# Entities, chats and channels (v1.43.x)

An **entity** is a user, chat, channel, or bot. Most methods accept an id, username, phone, or a resolved
entity object and will resolve it for you.

## Resolving

```python
me = await client.get_me()
user = await client.get_entity("durov")            # by username
chat = await client.get_entity(-1001234567890)     # by id (channels/supergroups are negative, -100…)
entity = await client.get_input_entity(username)   # lightweight handle, cheaper than full get_entity
```

Resolving a **username** for the first time costs a network round trip; afterwards Telethon caches it in the
session, so later calls are local. Resolving by **id alone** only works if the account has "seen" that entity
before (it's in the session cache or you encountered it via an update/dialog). If you get a "Could not find
the input entity" error, fetch it through a context that exposes it first (e.g. iterate dialogs, or use the
username/invite link once).

## Dialogs (the account's chat list)

```python
async for dialog in client.iter_dialogs():
    print(dialog.id, dialog.name, dialog.is_channel, dialog.is_group)
```

Iterating dialogs once at startup is a reliable way to warm the entity cache so later id-only lookups work.

## Channels vs groups vs users

- **Channel** — broadcast; only admins post. `dialog.is_channel` and not a megagroup.
- **Supergroup / group** — many members chat. Supergroups are also "channels" at the API level but
  `is_group` is `True`.
- Channel/supergroup ids are large negatives in the `-100…` form when used with the high-level API.

## Joining / leaving and admin actions

High-level helpers cover the common cases:

```python
await client.get_participants(entity, limit=200)   # member list (needs access; may be admin-gated)

# Lower-level operations go through functions in telethon.tl.functions.* invoked with client(...):
from telethon.tl.functions.channels import JoinChannelRequest, LeaveChannelRequest
await client(JoinChannelRequest(entity))
await client(LeaveChannelRequest(entity))
```

Admin-only operations (ban, promote, edit) raise `ChatAdminRequiredError` when the account lacks rights —
catch it and report clearly (see [errors-and-flood.md](errors-and-flood.md)).

## IDs and persistence

Store the **id** of channels/groups you monitor in config, but remember an id is only directly resolvable
once the account has seen the entity. For monitors/scrapers, resolve by username or invite link at first run,
then cache; persist the numeric id plus enough context (username) to re-resolve after a cold start.
