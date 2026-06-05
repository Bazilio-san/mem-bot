# Examples — end to end

Runnable scripts live alongside this doc in [`../examples/`](../examples). The snippets below show the three
ways an agent or app drives Fli.

## CLI

```bash
# One-way, non-stop, business, cheapest first
fli flights JFK LHR 2026-10-25 --class BUSINESS --stops NON_STOP --sort CHEAPEST

# Round-trip with a layover bound and locale
fli flights SFO NRT 2026-11-01 --return 2026-11-15 \
  --min-layover 60 --max-layover 240 --currency JPY --language ja --country JP

# Cheapest dates, round-trip, 7-day trips, machine-readable
fli dates JFK LHR --from 2026-01-01 --to 2026-02-15 --round --duration 7 --format json | jq '.dates[:5]'

# Resolve a city to codes, then search
fli airports "los angeles"     # LAX, BUR, SNA, ONT, LGB
fli flights JFK LAX 2026-10-25
```

## Python — one-way (typed library)

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

results = SearchFlights().search(filters) or []
priced = [f for f in results if not f.price_unknown]          # guard against missing prices
for flight in sorted(priced, key=lambda f: f.price)[:5]:
    legs = " → ".join(f"{leg.airline.value}{leg.flight_number}" for leg in flight.legs)
    print(f"${flight.price:.0f}  {flight.duration} min  {flight.stops} stop(s)  {legs}")
```

## Python — round-trip + booking URL

```python
from fli.models import (Airport, FlightSearchFilters, FlightSegment, PassengerInfo, TripType)
from fli.search import SearchFlights

filters = FlightSearchFilters(
    trip_type=TripType.ROUND_TRIP,
    passenger_info=PassengerInfo(adults=1),
    flight_segments=[
        FlightSegment(departure_airport=[[Airport.JFK, 0]], arrival_airport=[[Airport.LAX, 0]],
                      travel_date="2026-10-25"),
        FlightSegment(departure_airport=[[Airport.LAX, 0]], arrival_airport=[[Airport.JFK, 0]],
                      travel_date="2026-11-01"),
    ],
)

search = SearchFlights()
itineraries = search.search(filters, top_n=5) or []
for outbound, ret in itineraries[:3]:
    price = "N/A" if outbound.price_unknown else f"${outbound.price:.0f}"
    url = search.build_flight_booking_url((outbound, ret), currency="USD")   # deterministic deep link
    print(f"{price}  out {outbound.legs[0].flight_number}  ret {ret.legs[0].flight_number}")
    print(f"  book: {url}")
```

## Python — cheapest dates

```python
from fli.models import Airport, DateSearchFilters, FlightSegment, PassengerInfo
from fli.search import SearchDates

filters = DateSearchFilters(
    passenger_info=PassengerInfo(adults=1),
    flight_segments=[FlightSegment(departure_airport=[[Airport.JFK, 0]],
                                   arrival_airport=[[Airport.LHR, 0]], travel_date="2026-01-01")],
    from_date="2026-01-01", to_date="2026-02-15",
)

dates = SearchDates().search(filters) or []
for dp in sorted(dates, key=lambda d: d.price)[:10]:
    print(f"{dp.date[0].date()}  ${dp.price:.0f} {dp.currency or ''}")
```

## TypeScript — one-way

```ts
import { Airport, FlightSearchFilters, FlightSegment, MaxStops, SearchFlights, SeatType, SortBy } from "fli-js";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const filters = new FlightSearchFilters({
  passenger_info: { adults: 1, children: 0, infants_in_seat: 0, infants_on_lap: 0 },
  flight_segments: [new FlightSegment({
    departure_airport: [[[Airport.JFK, 0]]],   // triple-nested in TS
    arrival_airport: [[[Airport.LAX, 0]]],
    travel_date: inDays(30),
  })],
  seat_type: SeatType.ECONOMY, stops: MaxStops.NON_STOP, sort_by: SortBy.CHEAPEST,
});

const results = (await new SearchFlights().search(filters, { currency: "USD" })) ?? [];
for (const f of results.filter((x): x is import("fli-js").FlightResult => !Array.isArray(x) && x.price != null)
                        .sort((a, b) => (a.price! - b.price!)).slice(0, 5)) {
  console.log(`$${f.price}  ${f.duration} min  ${f.stops} stop(s)`);
}
```

## Driving Fli from an agent (Claude Agent SDK)

**Pattern A — MCP tools.** Register `fli-mcp` as an MCP server for the agent (see [mcp.md](mcp.md)); the agent
calls `find_airports`, then `search_flights` / `search_dates`, then optionally `get_booking_options`. No glue
code — the tools and their schemas come from the server.

**Pattern B — Python library inside an agent step.** Import `fli`, run the search, post-process (filter out
priceless rows, dedupe, rank), and return a compact result. Best when you need control over ranking before
the model sees the data. Use the snippets above verbatim.

**Pattern C — shell out to the CLI.** From a non-Python agent, run
`fli flights JFK LHR 2026-10-25 --format json`, capture stdout, and parse. Simplest to wire up, but the JSON
schema is experimental — pin the Fli version and treat a non-zero exit code as a hard error.

> Whichever pattern you use, surface the `booking_url` to the user so they can open the exact itinerary, and
> never claim a price for a row whose price is missing.
