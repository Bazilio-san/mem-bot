# Architecture — how Fli is built

Understanding the internals helps when extending Fli, debugging a `SearchParseError`, or deciding which
layer to call from an agent. The Python package and the TypeScript port (`fli-js`) share the same layering.

## Layers

```
   CLI (fli)            MCP server (fli-mcp / fli-mcp-http)
        \                         /
         \                       /
          v                     v
        fli.search  (SearchFlights, SearchDates)   ← orchestration
                     |
                     v
        fli.models  (FlightSearchFilters, FlightSegment, enums)  ← request shaping + .encode()
                     |
                     v
   fli.search internals (_wire, _decoders, _urls, _proto, _concurrency, client)
                     |
                     v
        Google FlightsFrontendService  (GetShoppingResults / GetCalendarGraph / GetBookingResults)
```

## Package map (Python)

| Module                       | Responsibility                                                                 |
|------------------------------|--------------------------------------------------------------------------------|
| `fli/models/`                | Pydantic models + enums. `FlightSearchFilters.format()`/`.encode()` build the Google request body. |
| `fli/search/flights.py`      | `SearchFlights` — `GetShoppingResults` calls, round-trip/multi-city expansion, booking follow-up. |
| `fli/search/dates.py`        | `SearchDates` — `GetCalendarGraph` calls, 61-day chunk splitting, `DatePrice` parsing. |
| `fli/search/client.py`       | Shared HTTP client (curl_cffi impersonating Chrome), rate limiting, retries.   |
| `fli/search/_wire.py`        | Parses Google's `)]}'`-prefixed, `wrb.fr`-chunked response envelope.            |
| `fli/search/_decoders.py`    | Turns raw nested arrays into `FlightResult` / `BookingOption`.                  |
| `fli/search/_urls.py`        | `with_locale_params` — appends `curr` / `hl` / `gl` query params.              |
| `fli/search/_proto.py`       | Builds the `tfs` / booking protobuf tokens for deep-link booking URLs.          |
| `fli/search/_concurrency.py` | `parallel_map` over a rate-limited worker pool (for leg expansion / date chunks). |
| `fli/core/`                  | Airport resolution, builders (`build_flight_segments`, …), currency, links, parsers. |
| `fli/cli/`                   | Typer commands: `flights`, `dates`, `airports`, `multi`.                        |
| `fli/mcp/`                   | FastMCP server: four tools, two prompts, one config resource.                  |

The TypeScript port mirrors this under `fli-js/src/` with the same names (`search/flights.ts`,
`models/google-flights/`, `core/`, etc.).

## Request lifecycle (a flight search)

1. The caller builds a `FlightSearchFilters` (airports, date, passengers, preferences).
2. `FlightSearchFilters.format()` serializes it into Google's deeply nested positional-array structure, then
   `.encode()` JSON-encodes and URL-quotes it into the `f.req` body. (The index map is documented inline in
   `fli/models/google_flights/flights.py` — most positions are unknown/no-effect; the meaningful ones are
   trip type, cabin, passengers, segments, bags, basic-economy.)
3. `SearchFlights._fetch_flights` POSTs to `GetShoppingResults` with `impersonate="chrome"`, applying locale
   params from `currency`/`language`/`country`.
4. `_wire.parse_first_wrb_payload` strips Google's anti-JSON prefix and extracts the first `wrb.fr` payload.
5. `_decoders.parse_flight_row` decodes each row into a `FlightResult`. Rows that fail to parse are skipped;
   if **every** row fails, a `SearchParseError` is raised (signal of a wire-format change).
6. For one-way, the list is returned. For round-trip/multi-city, `_expand_multi_leg` issues parallel
   follow-up `GetShoppingResults` calls (one per top-N outbound candidate) to enumerate the next leg, then
   assembles tuples.
7. The shopping-session id from the response (`inner[0][4]`) is cached on the `SearchFlights` instance so a
   later `get_booking_options` can derive a booking token automatically — this is why the instance is
   **not thread-safe**.

## Booking follow-up

`get_booking_options` re-uses the cached session id (or an explicit `session_id` / `booking_token`) to call
`GetBookingResults`, returning `BookingOption` rows (vendor, price, booking URL). Separately,
`build_flight_booking_url` constructs a **deterministic** `tfs` deep link from the itinerary's airports,
dates, and flight numbers — no network call, no session needed — so every result can always link to its
exact Google Flights booking page even when the vendor list comes back empty.

## HTTP client behaviour

- Built on `curl_cffi`, impersonating Chrome's TLS/HTTP fingerprint to look like a real browser.
- **Rate limited to ~10 requests/second** with automatic retries and exponential backoff on transient
  failures (`tenacity`).
- Proxy support via `HTTP_PROXY` / `HTTPS_PROXY` env vars (TS: also a `proxy` option on `Client`).
- Typed errors: `SearchClientError` (base), `SearchTimeoutError`, `SearchConnectionError`,
  `SearchHTTPError`; plus `SearchParseError` for "responded but shape changed".
