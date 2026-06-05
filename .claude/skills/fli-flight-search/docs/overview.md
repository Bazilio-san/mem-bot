# Overview — what Fli is

Fli is a toolkit for reading **Google Flights** data programmatically. Unlike libraries that scrape HTML or
drive a headless browser, Fli sends requests straight to Google's internal
`travel.frontend.flights.FlightsFrontendService` endpoints and decodes the raw response payloads. The
practical consequences:

- **Fast** — one HTTP round trip per search, no page rendering.
- **No browser** — nothing to install beyond the package; no Selenium/Playwright.
- **Fragile by nature** — it depends on Google's private wire format, which can change without warning.

## What you can do with it

| Capability                        | CLI command        | MCP tool              | Python / TS class            |
|-----------------------------------|--------------------|-----------------------|------------------------------|
| Search flights on a date          | `fli flights`      | `search_flights`      | `SearchFlights.search`       |
| Find cheapest dates in a window   | `fli dates`        | `search_dates`        | `SearchDates.search`         |
| Get bookable fares + booking URLs | (in `flights` out) | `get_booking_options` | `SearchFlights.get_booking_options` |
| Resolve a city/name to IATA codes | `fli airports`     | `find_airports`       | `fli.core.search_airports`   |
| Multi-city itineraries            | `fli multi`        | `search_flights`*     | `FlightSearchFilters` (multi segments) |

\* The MCP `search_flights` tool covers one-way and round-trip; multi-city with 3+ legs is most directly
expressed through the library's `FlightSearchFilters` with several `FlightSegment`s, or the `fli multi` CLI.

## Trip types

- **One-way** — a single `FlightSegment`. `search()` returns a flat list of `FlightResult`.
- **Round-trip** — two segments (out + back). `search()` returns a list of **tuples** `(outbound, return)`.
  Google reports the full round-trip price on the outbound row.
- **Multi-city** — 3+ segments. `search()` returns tuples with one `FlightResult` per leg, in order.

## Search filters at a glance

Both flight and date searches accept the same core filter vocabulary (full reference in
[python-api.md](python-api.md) and [mcp.md](mcp.md)):

- **Cabin class** — `ECONOMY`, `PREMIUM_ECONOMY`, `BUSINESS`, `FIRST`.
- **Stops** — `ANY`, `NON_STOP`, `ONE_STOP`, `TWO_PLUS_STOPS` (CLI/MCP spelling).
- **Airlines** — include or exclude by IATA code (`BA`, `AA`, …).
- **Alliances** — include or exclude `ONEWORLD`, `SKYTEAM`, `STAR_ALLIANCE`.
- **Layover bounds** — `min_layover` / `max_layover` in minutes (multi-stop trips only).
- **Departure window** — `HH-HH` 24-hour local time (e.g. `6-20`).
- **Sort** — `CHEAPEST`, `DURATION`, `DEPARTURE_TIME`, `ARRIVAL_TIME` (plus `TOP_FLIGHTS`, `BEST`,
  `EMISSIONS` at the library level).
- **Bags / emissions / basic-economy** — include checked/carry-on bag fees in the price, filter to lower
  emissions, or exclude basic-economy fares.
- **Locale** — `currency` (ISO 4217), `language` (BCP-47), `country` (ISO 3166-1 alpha-2). Set per call.
- **Passengers** — adult count (CLI/MCP); the library's `PassengerInfo` also supports children and infants.

## Versions and surfaces

- **Python package**: `flights` on PyPI, requires Python ≥ 3.10. Imported as `import fli`.
- **Console scripts**: `fli` (CLI), `fli-mcp` (STDIO MCP), `fli-mcp-http` (HTTP MCP).
- **MCP extra**: the server needs `pip install "flights[mcp]"` (adds `fastmcp`, `pydantic-settings`,
  `uvicorn`, `fastapi`).
- **TypeScript package**: `fli-js` on npm — a 1:1 port (same models, same encoding). ESM; runs on Bun or on
  Node via a loader like `tsx`.
- **License**: MIT. Repository: `github.com/punitarani/fli`. Docs: `punitarani.github.io/fli`.

## Output shape (high level)

A flight result carries `price`, `currency`, total `duration` (minutes), `stops`, and a list of `legs`. Each
leg has the operating airline, flight number, departure/arrival airports and datetimes, and optional rich
fields (aircraft, legroom, amenities, layovers). Results also expose Google Flights **deep-link booking
URLs** so a user can open the exact itinerary. Date results carry the date(s), price, currency, and a
per-date booking URL. See [python-api.md](python-api.md) for the exact model fields.
