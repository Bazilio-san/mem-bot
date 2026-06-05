---
name: fli-flight-search
description: >
  Use Fli to search Google Flights programmatically — via CLI (`fli`), MCP server (`fli-mcp` /
  `fli-mcp-http`), Python library (`flights` package), or TypeScript library (`fli-js`). Use when the
  task is searching flights, finding cheapest travel dates, getting bookable fares / booking URLs,
  resolving airport IATA codes, wiring Fli into a Python/TypeScript app, exposing it as an MCP tool to
  Claude Code / Claude Desktop / Codex, or driving it from an agent. Covers install, the four MCP tools
  (search_flights, search_dates, get_booking_options, find_airports), model/filter shapes, locale
  (currency/language/country), and the limits of a reverse-engineered API.
license: MIT
metadata:
  author: skill generated for the Fli project (github.com/punitarani/fli)
  version: 1.0.0
  upstream-package-python: flights
  upstream-package-typescript: fli-js
---

# Fli — Google Flights search (CLI · MCP · Python · TypeScript)

Fli is a library that reads Google Flights data by talking **directly to Google's internal
`FlightsFrontendService` API** (reverse-engineered), not by scraping HTML or driving a browser. It ships
four ways to call it, and this skill helps you pick the right one and use it correctly:

1. **CLI** — `fli` terminal command. Best for one-off searches, shell scripts, and agents that shell out.
2. **MCP server** — `fli-mcp` (STDIO) / `fli-mcp-http` (HTTP). Best for Claude Code, Claude Desktop, Codex,
   and any MCP client that should search flights through natural language.
3. **Python library** — the `flights` PyPI package (`import fli`). Best for embedding in a Python app or
   agent that needs typed results.
4. **TypeScript library** — the `fli-js` npm package. A 1:1 port of the Python API for Node/Bun apps.

## Decision guide — pick the surface first

| The user wants to…                                                        | Use            | Read                          |
|---------------------------------------------------------------------------|----------------|-------------------------------|
| Run a flight/date search from the terminal or a shell script              | CLI            | [docs/cli.md](docs/cli.md)            |
| Let Claude / Codex search flights in conversation                         | MCP server     | [docs/mcp.md](docs/mcp.md)            |
| Embed flight search in a Python program or agent                          | Python library | [docs/python-api.md](docs/python-api.md) |
| Embed flight search in a Node / Bun / TypeScript program                  | TypeScript lib | [docs/typescript-api.md](docs/typescript-api.md) |
| Understand how Fli is built before extending it                           | —              | [docs/architecture.md](docs/architecture.md) |
| Know what Fli can and cannot reliably do                                  | —              | [docs/limitations.md](docs/limitations.md) |
| See full runnable end-to-end snippets                                     | —              | [docs/examples.md](docs/examples.md) |

A high-level tour of what Fli is and its capabilities lives in [docs/overview.md](docs/overview.md).

## Install — the one rule that trips people up

The **PyPI package is named `flights`**, but the **commands are `fli`, `fli-mcp`, `fli-mcp-http`**. Never
tell a user to `pip install fli` — that installs an unrelated package.

```bash
# CLI only (recommended: pipx keeps it isolated and puts `fli` on PATH)
pipx install flights

# CLI + MCP server (the MCP server needs the optional [mcp] extra — fastmcp etc.)
pipx install "flights[mcp]"        # or: pip install "flights[mcp]"

# Library use inside an existing Python project
pip install flights                # requires Python >= 3.10

# TypeScript / JavaScript
bun add fli-js                     # or: npm install fli-js / pnpm add fli-js
```

If `fli` / `fli-mcp` is "command not found" right after a successful `pipx install`, the PATH is not wired
up yet — run `python3 -m pipx ensurepath` and restart the terminal. The `fli-mcp` script is registered even
without the `[mcp]` extra, but it exits with `MCP dependencies are not installed. Install them with:
pip install 'flights[mcp]'` until you add the extra.

## Fastest path per surface

**CLI** (no Python knowledge needed):

```bash
fli flights JFK LAX 2026-10-25                       # one-way search
fli dates JFK LHR --from 2026-01-01 --to 2026-01-31  # cheapest dates in a window
fli airports "new york"                              # resolve city → IATA codes
```

**MCP for Claude Code** — register the STDIO server (this is the project's own `.mcp.json`, or run
`claude mcp add`):

```json
{ "mcpServers": { "fli": { "command": "fli-mcp", "args": [] } } }
```

For Claude Desktop / other clients, see [examples/claude_mcp_config.json](examples/claude_mcp_config.json)
and [docs/mcp.md](docs/mcp.md).

**Python** (typed library):

```python
from datetime import datetime, timedelta
from fli.models import Airport, FlightSearchFilters, FlightSegment, PassengerInfo, SeatType, MaxStops, SortBy
from fli.search import SearchFlights

filters = FlightSearchFilters(
    passenger_info=PassengerInfo(adults=1),
    flight_segments=[FlightSegment(
        departure_airport=[[Airport.JFK, 0]],
        arrival_airport=[[Airport.LAX, 0]],
        travel_date=(datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d"),
    )],
    seat_type=SeatType.ECONOMY, stops=MaxStops.NON_STOP, sort_by=SortBy.CHEAPEST,
)
for flight in SearchFlights().search(filters) or []:
    print(flight.price, flight.duration, flight.stops)
```

Full runnable versions: [examples/search_flights.py](examples/search_flights.py) and
[examples/search_dates.py](examples/search_dates.py).

## The MCP server exposes four tools (not two)

The README mentions two, but the current server registers **four** read-only tools, two prompt templates,
and a configuration resource. When guiding an agent or a user, use the real set:

| Tool                  | Purpose                                                                         |
|-----------------------|---------------------------------------------------------------------------------|
| `search_flights`      | Flights between two airports on a date (one-way or round-trip), with filters.    |
| `search_dates`        | Cheapest travel dates across a flexible date range.                              |
| `get_booking_options` | Bookable fares (vendor names, prices, direct booking URLs) for one itinerary.    |
| `find_airports`       | Resolve a city/airport name or IATA code to airport codes — call this first.     |

Details, parameter tables, and response shapes: [docs/mcp.md](docs/mcp.md).

## Critical facts that prevent wrong answers

These apply across all four surfaces. Treat them as standing constraints.

- **`travel_date` must not be in the past, and you cannot search more than ~305 days ahead.** Date searches
  larger than 61 days are auto-split into multiple calls.
- **Prices can be `None`.** Google omits a per-row price for some itineraries (notably premium-cabin
  BUSINESS/FIRST round-trips). In Python guard with `flight.price_unknown`; in TS check `flight.price == null`.
  Sort/min/aggregate only over rows that have a price.
- **`get_booking_options` often returns an empty `options` list.** Google's booking endpoint usually needs a
  browser-minted session token that Fli does not reproduce server-side. When `options` is empty, use
  `selected_flight.booking_url` (a deep link to that exact itinerary) or the top-level `booking_url`.
- **Locale is set per call, not on the filter object.** Pass `currency` (ISO 4217, → `curr=`), `language`
  (BCP-47, → `hl=`), and `country` (ISO 3166-1 alpha-2, → `gl=`) to `search(...)` / the MCP tool, not into
  `FlightSearchFilters`.
- **`SearchFlights` is not thread-safe.** It caches the shopping-session id for the booking follow-up.
  For concurrent/async use, create one `SearchFlights` per request.
- **It can break without notice.** This is an unofficial, reverse-engineered Google API. A wire-format change
  surfaces as `SearchParseError` ("response shape may have changed"). Transient failures are normal — retry
  after a short delay before assuming the setup is broken. See [docs/limitations.md](docs/limitations.md).
- **Stop-filter naming differs by layer.** The CLI and MCP accept friendly names
  (`NON_STOP`, `ONE_STOP`, `TWO_PLUS_STOPS`); the Python/TS `MaxStops` enum uses
  `NON_STOP`, `ONE_STOP_OR_FEWER`, `TWO_OR_FEWER_STOPS`. The parsers map between them.
- **`--format json` (CLI) is experimental** — the schema may change. Prefer the library or MCP for stable
  machine-readable output.

## Using Fli from an agent (Agent tool / Claude Agent SDK)

Three viable patterns, in order of preference:

1. **Expose the MCP server** to the agent and let it call `search_flights` / `search_dates` /
   `get_booking_options` / `find_airports` as tools. Cleanest for conversational agents.
2. **Import the Python library** inside a Python agent step and return the typed results. Best when you need
   to post-process (filter by price, dedupe, rank) before answering.
3. **Shell out to the CLI** with `--format json` and parse stdout. Simplest for non-Python agents, but the
   JSON schema is experimental — pin the Fli version.

Worked examples of all three: [docs/examples.md](docs/examples.md).

## When NOT to use this skill

- General travel advice, visa rules, hotel booking, or loyalty-program questions — Fli only searches flights
  and dates.
- Actually purchasing a ticket — Fli returns booking **URLs**, it does not complete a transaction.
- Scraping arbitrary Google pages — Fli targets the flights endpoints specifically.
