# Limitations and gotchas

Fli is powerful but it rides on an **unofficial, reverse-engineered Google Flights API**. Set expectations
accordingly and code defensively.

## Reliability / stability

- **Can break without notice.** Google can change its private wire format at any time. The symptom is a
  `SearchParseError` ("Google response shape may have changed") even though the HTTP request succeeded. This
  is a Fli/Google issue, not a setup error — check for a Fli update.
- **Transient failures are normal.** Live requests occasionally fail or return nothing. Retry once after a
  short delay before concluding the CLI/MCP/library is misconfigured. The HTTP client already rate-limits
  (~10 req/s) and retries with backoff, but it cannot mask every upstream hiccup.
- **No SLA, no official support.** It is not a sanctioned Google product; do not build a hard dependency
  without a fallback.

## Data / result quirks

- **Prices can be missing (`None` / `null`).** Google omits a per-row aggregate price for some itineraries —
  predictably for premium-cabin (BUSINESS/FIRST) round-trips with multiple passengers. Always guard before
  sorting, comparing, or computing a minimum. Python: `flight.price_unknown`. TypeScript: `flight.price == null`.
- **`get_booking_options` often returns no vendors.** Google's `GetBookingResults` usually requires a
  browser-minted session token that Fli does not reproduce server-side, so `options` comes back `[]` with a
  `note`. The per-itinerary `selected_flight.booking_url` (a deterministic `tfs` deep link) still works — use
  it to open the exact booking page. The top-level `booking_url` is a broader search-page fallback.
- **Fli returns booking links, not purchases.** It never completes a transaction; the user finishes booking
  on Google Flights or the airline/OTA site.
- **`--format json` (CLI) is experimental.** The JSON schema may change between releases. For a stable
  contract use the library or MCP server, and pin the Fli version if you must parse CLI JSON.

## Input constraints

- **`travel_date` must be in the future.** Past dates are rejected at validation time.
- **No searches more than ~305 days ahead.** Google's calendar horizon caps how far out you can look.
- **Date ranges > 61 days are auto-split** into multiple calls (transparent, but it costs extra requests).
- **Departure/arrival airports must differ** within a segment.
- **Stop-filter naming differs by layer.** CLI/MCP use `NON_STOP` / `ONE_STOP` / `TWO_PLUS_STOPS`; the
  Python/TS `MaxStops` enum uses `NON_STOP` / `ONE_STOP_OR_FEWER` / `TWO_OR_FEWER_STOPS`.
- **Alliance spelling is strict.** Use `STAR_ALLIANCE` (underscore) — `"Star Alliance"` / `"STAR ALLIANCE"`
  return zero results. Valid values: `ONEWORLD`, `SKYTEAM`, `STAR_ALLIANCE`.

## Concurrency

- **`SearchFlights` is not thread-safe.** It caches the shopping-session id (needed for the booking
  follow-up). Concurrent `search()` calls on one instance race on that cache. For parallel/async servers,
  instantiate one `SearchFlights` per request, or pass `session_id` explicitly to `get_booking_options`.

## Feature gaps

- **Self-transfer cannot be toggled.** Fli uses Google's "flat" request format (the wrapper format returns
  empty results without browser cookies), and self-transfer is only settable in the wrapper format.
- **Passenger types beyond adults** (children/infants) exist in the library's `PassengerInfo` but the CLI and
  MCP tools expose only an adult `passengers` count.
- **Locale ≠ filter.** `currency` / `language` / `country` are per-call arguments, not fields on
  `FlightSearchFilters`. Setting currency does not always change what Google bills in — Google may pick by
  IP/locale regardless.

## Legal / ethical

Using a reverse-engineered private API may conflict with Google's Terms of Service. Respect rate limits,
avoid hammering the endpoints, and use it for legitimate personal/research purposes. This skill does not
grant any rights to the underlying API.
