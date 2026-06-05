# Python API

Install: `pip install flights` (Python ≥ 3.10). Import root is `fli`.

```python
from fli.models import (
    Airport, Airline, FlightSearchFilters, DateSearchFilters, FlightSegment,
    PassengerInfo, SeatType, MaxStops, SortBy, TripType, Alliance,
    EmissionsFilter, BagsFilter, LayoverRestrictions, PriceLimit,
)
from fli.search import SearchFlights, SearchDates
```

## SearchFlights

```python
search = SearchFlights()
results = search.search(filters, top_n=5, currency=None, language=None, country=None)
```

- `filters: FlightSearchFilters` — full search descriptor.
- `top_n: int = 5` — how many outbound candidates to expand for round-trip / multi-city.
- `currency` / `language` / `country` — locale, applied **per call** (not on the filter). ISO 4217 / BCP-47 /
  ISO 3166-1 alpha-2.
- **Returns**: one-way → `list[FlightResult]`; round-trip / multi-city → `list[tuple[FlightResult, ...]]`
  (one element per leg, in order); `None` when there are no results. **Always handle `None`.**

```python
search.get_booking_options(flight, filters, currency=None, language=None, country=None,
                           booking_token=None, session_id=None) -> list[BookingOption]
```

Call `search(...)` **first** on the same instance so the shopping-session id is cached; then pass one result
(or a tuple) back in. Often returns `[]` (see [limitations.md](limitations.md)).

```python
search.build_flight_booking_url(flight, *, currency=None, language=None, country=None) -> str
```

Deterministic `https://www.google.com/travel/flights/booking?tfs=…` deep link for an itinerary. No network
call; never raises (falls back to a generic URL on malformed input).

> **Concurrency**: `SearchFlights` is **not thread-safe** — it caches session state. For parallel/async use,
> create one instance per request, or pass `session_id` explicitly to `get_booking_options`.

## SearchDates

```python
dates = SearchDates().search(filters, currency=None, language=None, country=None)  # -> list[DatePrice] | None
```

- `filters: DateSearchFilters`.
- Date ranges > 61 days are split into multiple calls automatically; you cannot search > ~305 days ahead.
- `DatePrice.date` is a tuple of `datetime`: `(outbound,)` one-way, `(outbound, return)` round-trip.
  `DatePrice.price: float`, `DatePrice.currency: str | None`.

## Building filters

`FlightSearchFilters` fields (Pydantic model; defaults shown):

| Field                  | Type / default                         | Notes                                                       |
|------------------------|----------------------------------------|-------------------------------------------------------------|
| `trip_type`            | `TripType = ONE_WAY`                    | `ONE_WAY`, `ROUND_TRIP`, `MULTI_CITY`.                       |
| `passenger_info`       | `PassengerInfo` (required)              | `adults`, `children`, `infants_in_seat`, `infants_on_lap`.  |
| `flight_segments`      | `list[FlightSegment]` (required)        | One per leg.                                                 |
| `stops`                | `MaxStops = ANY`                        | See enum below.                                              |
| `seat_type`            | `SeatType = ECONOMY`                    | Cabin class.                                                 |
| `price_limit`          | `PriceLimit | None`                     | `max_price` + `currency`.                                    |
| `airlines`             | `list[Airline] | None`                  | Include only these carriers.                                 |
| `airlines_exclude`     | `list[Airline] | None`                  | Exclude these carriers.                                      |
| `alliances`            | `list[Alliance] | None`                 | Include only these alliances.                                |
| `alliances_exclude`    | `list[Alliance] | None`                 | Exclude these alliances.                                     |
| `max_duration`         | `int | None`                            | Total trip max duration in minutes.                          |
| `layover_restrictions` | `LayoverRestrictions | None`            | `airports`, `min_duration`, `max_duration` (minutes).        |
| `sort_by`              | `SortBy = BEST`                         | See enum below.                                              |
| `exclude_basic_economy`| `bool = False`                          |                                                              |
| `emissions`            | `EmissionsFilter = ALL`                 | `ALL` or `LESS`.                                             |
| `bags`                 | `BagsFilter | None`                     | `checked_bags`, `carry_on` — folds bag fees into price.      |
| `show_all_results`     | `bool = True`                           | `True` = all rows; `False` = Google's curated ~30.           |

`DateSearchFilters` has the same core fields plus `from_date`, `to_date` (YYYY-MM-DD) and `duration`
(round-trip length in days).

### Enums

```python
SeatType:  ECONOMY, PREMIUM_ECONOMY, BUSINESS, FIRST
MaxStops:  ANY, NON_STOP, ONE_STOP_OR_FEWER, TWO_OR_FEWER_STOPS   # library spelling
SortBy:    TOP_FLIGHTS, BEST, CHEAPEST, DEPARTURE_TIME, ARRIVAL_TIME, DURATION, EMISSIONS
TripType:  ONE_WAY, ROUND_TRIP, MULTI_CITY
Alliance:  ONEWORLD, SKYTEAM, STAR_ALLIANCE
EmissionsFilter: ALL, LESS
```

> The CLI/MCP accept the friendlier `ONE_STOP` / `TWO_PLUS_STOPS`; the library enum uses
> `ONE_STOP_OR_FEWER` / `TWO_OR_FEWER_STOPS`. Use the enum values directly in Python.

### FlightSegment — airport nesting

In **Python**, each airport is a `[Airport, 0]` pair inside a list:

```python
FlightSegment(
    departure_airport=[[Airport.JFK, 0]],
    arrival_airport=[[Airport.LAX, 0]],
    travel_date="2026-10-25",          # YYYY-MM-DD, must not be in the past
    time_restrictions=None,            # optional TimeRestrictions (hours from midnight)
)
```

(The TypeScript port uses an extra nesting level — see [typescript-api.md](typescript-api.md).)

## FlightResult / FlightLeg fields

`FlightResult`: `legs: list[FlightLeg]`, `price: float | None`, `currency: str | None`,
`duration: int` (minutes), `stops: int`, plus optional `layovers`, `co2_emissions_g`, `primary_airline`,
`booking_token`, etc. **`price` is `None` for some itineraries** — use the `price_unknown` property:

```python
cheapest = min((f for f in results if not f.price_unknown), key=lambda f: f.price, default=None)
```

`FlightLeg`: `airline: Airline`, `flight_number: str`, `departure_airport`, `arrival_airport`,
`departure_datetime`, `arrival_datetime`, `duration` (minutes), plus optional `aircraft`, `legroom`,
`amenities`, `operating_airline`, `overnight`.

## Airport resolution

```python
from fli.core import search_airports, resolve_airport
search_airports("new york", limit=10)   # -> list of matches (code, name, match_type)
resolve_airport("JFK")                   # -> Airport enum
```

City names expand to multiple airports (e.g. `"new york"` → JFK, LGA, EWR; `"london"` → LHR, LGW, STN, LTN,
LCY). The `Airport` and `Airline` enums enumerate every supported code.

## Errors

```python
from fli.search import SearchClientError, SearchTimeoutError, SearchConnectionError, SearchHTTPError
from fli.search.flights import SearchParseError
```

`SearchParseError` means Google responded but the shape changed (likely a wire-format update). The others are
network/HTTP failures. Retry transient failures after a short delay.

See [examples.md](examples.md) for complete, runnable programs.
