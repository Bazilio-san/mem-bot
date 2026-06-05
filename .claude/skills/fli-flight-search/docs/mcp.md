# MCP server (`fli-mcp` / `fli-mcp-http`)

The MCP server is a [FastMCP](https://github.com/jlowin/fastmcp) server that exposes flight search as tools
an AI assistant can call. It registers **four tools**, **two prompts**, and **one configuration resource**.

## Install (needs the `[mcp]` extra)

The console scripts are always registered, but the server code needs the optional `[mcp]` dependencies
(`fastmcp`, `pydantic-settings`, `uvicorn`, `fastapi`). Without them, `fli-mcp` prints
`MCP dependencies are not installed. Install them with: pip install 'flights[mcp]'`.

```bash
pipx install "flights[mcp]"     # recommended; or: pip install "flights[mcp]"
fli-mcp --help                   # STDIO server
which fli-mcp                    # full path, handy for client configs
```

## Transports

```bash
fli-mcp          # STDIO — for Claude Desktop, Claude Code, Codex, most local clients
fli-mcp-http     # HTTP (streamable) — serves at http://127.0.0.1:8000/mcp/ by default
```

The HTTP server binds `0.0.0.0:8000` by default (reachable off-host — intentional for container/Railway
deploys). Restrict it to loopback with `HOST=127.0.0.1`, override the port with `PORT`. HTTP clients must
send `Accept: application/json, text/event-stream` and hit the `/mcp/` path.

## Wiring into clients

**Claude Code** — add to the project's `.mcp.json` (or run `claude mcp add fli -- fli-mcp`):

```json
{ "mcpServers": { "fli": { "command": "fli-mcp", "args": [] } } }
```

**Claude Desktop** — edit `claude_desktop_config.json`, then fully quit and relaunch the app:

```json
{ "mcpServers": { "fli": { "command": "fli-mcp" } } }
```

Config file locations: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows
`%APPDATA%\Claude\claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json`. If the
client cannot find `fli-mcp`, use the absolute path from `which fli-mcp`. A ready-to-copy file with env-var
defaults is in [../examples/claude_mcp_config.json](../examples/claude_mcp_config.json).

**Codex** — register `fli-mcp` as a STDIO MCP server in the Codex MCP configuration the same way (command
`fli-mcp`, no args).

## The four tools

### `find_airports` — resolve a place to IATA codes (call this first)

| Param   | Type | Default | Notes                                                |
|---------|------|---------|------------------------------------------------------|
| `query` | str  | —       | City, airport name, or IATA code (`new york`, `LHR`) |
| `limit` | int  | 10      | Max results (1–50)                                    |

Returns `{ success, query, count, airports: [{ code, name, match_type }] }`. Use it to turn "New York" into
`JFK,LGA,EWR` before a flight search.

### `search_flights` — flights on a date

Required: `origin`, `destination` (IATA, comma-separated for multi-airport, e.g. `JFK,LGA`),
`departure_date` (YYYY-MM-DD). Optional: `return_date` (round-trip), `departure_window` (`HH-HH`),
`airlines` / `exclude_airlines` (lists), `alliance` / `exclude_alliance`, `min_layover` / `max_layover`
(minutes), `cabin_class` (ECONOMY/PREMIUM_ECONOMY/BUSINESS/FIRST), `max_stops`
(ANY/NON_STOP/ONE_STOP/TWO_PLUS_STOPS), `sort_by`
(CHEAPEST/BEST/TOP_FLIGHTS/DEPARTURE_TIME/ARRIVAL_TIME/DURATION/EMISSIONS), `passengers`,
`exclude_basic_economy`, `emissions` (ALL/LESS), `checked_bags` (0–2), `carry_on`, `show_all_results`,
`currency` / `language` / `country`.

Returns `{ success, flights: [...], count, trip_type, booking_url }`. Each flight has `price`, `currency`,
`legs[]`, and its own `booking_url` (a `tfs` deep link to that exact itinerary). The top-level `booking_url`
is a broader search-page link and a reliable fallback.

### `search_dates` — cheapest dates in a range

Required: `origin`, `destination`, `start_date`, `end_date` (YYYY-MM-DD). Optional: `trip_duration` (days,
default 3), `is_round_trip`, `sort_by_price`, plus the same airline/alliance/layover/class/stops/window/
locale/passenger filters as `search_flights`.

Returns `{ success, dates: [{ date, price, currency, return_date, booking_url }], count, trip_type,
date_range }`.

### `get_booking_options` — bookable fares for one itinerary

Required: `origin`, `destination`, `departure_date`. Key optional: `flight_numbers` — ordered list
identifying the itinerary (e.g. `['BA178']` one-way, `['AA100','AA200']` round-trip; bare `'178'` or
prefixed `'BA178'` both accepted; omit to price the top result). Plus the usual filters.

**Run `search_flights` first** to discover flight numbers, then pass them here. **Pass the same filters** you
used for the search so the re-run reproduces the same result set.

Returns `{ success, selected_flight, options: [{ vendor_name, vendor_code, is_airline_direct, price,
currency, booking_url, google_click_url }], count, booking_url }`. When no flight matches `flight_numbers`,
`success` is `false` and `available_flights` lists the sequences that were found.

> **`options` is frequently empty.** Google's booking endpoint usually needs a browser-minted session token
> that the server cannot reproduce. When empty, the response carries a `note`; use
> `selected_flight.booking_url` to open that itinerary's booking page directly.

## Prompts

- **`search-direct-flight`** — args `origin`, `destination`, `date?`, `prefer_non_stop?`. Generates a guided
  `search_flights` call (defaults to today, prefers non-stop).
- **`find-budget-window`** — args `origin`, `destination`, `start_date?`, `end_date?`, `duration?`. Generates
  a guided `search_dates` call over a flexible window.

## Configuration resource and env vars

The resource `resource://fli-mcp/configuration` returns the live defaults and schema. Override defaults with
`FLI_MCP_`-prefixed environment variables (set them in the `env` block of the client config):

| Variable                          | Effect                                  | Default       |
|-----------------------------------|-----------------------------------------|---------------|
| `FLI_MCP_DEFAULT_PASSENGERS`      | Default adult passenger count           | 1             |
| `FLI_MCP_DEFAULT_CURRENCY`        | Fallback currency for results           | USD           |
| `FLI_MCP_DEFAULT_CABIN_CLASS`     | Default cabin class                     | ECONOMY       |
| `FLI_MCP_DEFAULT_SORT_BY`         | Default sort strategy                   | CHEAPEST      |
| `FLI_MCP_DEFAULT_DEPARTURE_WINDOW`| Default departure window `HH-HH`        | (none)        |
| `FLI_MCP_MAX_RESULTS`             | Cap on results returned per tool        | (no limit)    |

## Validating the connection

After wiring it up, ask the assistant: *"Search for flights from JFK to LHR on 2026-03-15."* If the tools
don't appear: confirm `fli-mcp --help` runs in a terminal, the config path and JSON are valid, the `[mcp]`
extra is installed, and (Claude Desktop) the app was fully quit and reopened.
