# TypeScript / JavaScript API (`fli-js`)

`fli-js` is a 1:1 port of the Python library — same models, same filter encoding, same wire decoders. Install:

```bash
bun add fli-js     # or: npm install fli-js / pnpm add fli-js
```

ESM only, with bundled type definitions. Runs on **Bun** directly, or on **Node** via a TypeScript loader
such as [`tsx`](https://github.com/privatenumber/tsx).

```ts
import {
  Airport, Airline, Alliance,
  FlightSearchFilters, DateSearchFilters, FlightSegment,
  SearchFlights, SearchDates,
  SeatType, MaxStops, SortBy, TripType, Client,
} from "fli-js";
```

## Two key differences from Python

1. **Airport nesting is triple-deep.** Where Python writes `[[Airport.JFK, 0]]`, TypeScript writes
   `[[[Airport.JFK, 0]]]`. The inner pair is `[airport, 0]`; the extra levels mirror the wire format.

2. **Classes vs plain objects.** `FlightSearchFilters`, `DateSearchFilters`, and `FlightSegment` are
   **classes** — construct them with `new`. `PassengerInfo`, `TimeRestrictions`, and `LayoverRestrictions`
   are **object types** (Zod schemas) — pass plain object literals.

## One-way search

```ts
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const filters = new FlightSearchFilters({
  passenger_info: { adults: 1, children: 0, infants_in_seat: 0, infants_on_lap: 0 },
  flight_segments: [
    new FlightSegment({
      departure_airport: [[[Airport.JFK, 0]]],
      arrival_airport: [[[Airport.LAX, 0]]],
      travel_date: inDays(30),               // YYYY-MM-DD, must be in the future
    }),
  ],
  seat_type: SeatType.ECONOMY,
  stops: MaxStops.NON_STOP,
  sort_by: SortBy.CHEAPEST,
});

const results = await new SearchFlights().search(filters, { currency: "USD" });
for (const flight of results ?? []) {
  console.log(`$${flight.price ?? "N/A"} — ${flight.duration} min — ${flight.stops} stop(s)`);
}
```

## search() signature

```ts
search(filters: FlightSearchFilters, options?: SearchOptions):
  Promise<Array<FlightResult | FlightResult[]> | null>

interface SearchOptions { topN?: number; currency?: string | null; language?: string | null; country?: string | null; }
```

- One-way → `FlightResult[]`. Round-trip / multi-city → `FlightResult[][]` (each inner array is one
  itinerary, one `FlightResult` per leg). `null` when empty.
- Locale goes in `options` (`currency` → `curr`, `language` → `hl`, `country` → `gl`), **not** in the filter.

```ts
// Round-trip: two segments, returns array of [outbound, return] tuples.
const itineraries = (await new SearchFlights().search(rtFilters, { topN: 5 })) as FlightResult[][] | null;
for (const [outbound, ret] of itineraries ?? []) {
  console.log(`Total $${outbound.price ?? "N/A"} (return ${ret.legs[0].flight_number})`);
}
```

`flight.price` can be `null` (premium-cabin round-trips, etc.) — guard before sorting/min.

## Cheapest dates

```ts
const filters = new DateSearchFilters({
  passenger_info: { adults: 1, children: 0, infants_in_seat: 0, infants_on_lap: 0 },
  flight_segments: [
    new FlightSegment({
      departure_airport: [[[Airport.JFK, 0]]],
      arrival_airport: [[[Airport.LAX, 0]]],
      travel_date: inDays(30),
    }),
  ],
  from_date: inDays(30),
  to_date: inDays(60),
});

const dates = await new SearchDates().search(filters);
for (const { date, price } of dates ?? []) {
  console.log(`${date[0].toISOString().slice(0, 10)} — $${price}`);
}
```

`DatePrice.date` is a tuple of `Date`: `[outbound]` one-way, `[outbound, return]` round-trip. Ranges > 61
days split automatically.

## Filters, alliances, locale

```ts
const filters = new FlightSearchFilters({
  passenger_info: { adults: 1, children: 0, infants_in_seat: 0, infants_on_lap: 0 },
  flight_segments: [
    new FlightSegment({
      departure_airport: [[[Airport.JFK, 0]]],
      arrival_airport: [[[Airport.NRT, 0]]],
      travel_date: inDays(30),
    }),
  ],
  seat_type: SeatType.BUSINESS,
  stops: MaxStops.ONE_STOP_OR_FEWER,
  alliances: [Alliance.ONEWORLD],
  airlines_exclude: [Airline.AA],
  layover_restrictions: { airports: null, min_duration: 60, max_duration: 240 }, // minutes
  max_duration: 1200,                                                            // minutes
});

const flights = await new SearchFlights().search(filters, { currency: "EUR", language: "en-GB", country: "GB" });
```

## Configuring the HTTP client

```ts
const client = new Client({
  timeoutMs: 30_000,
  retries: 5,
  proxy: "http://user:pass@proxy.example.com:8080",   // or HTTPS_PROXY / HTTP_PROXY env
});
const search = new SearchFlights(client);
```

Rate-limits to ~10 req/s with exponential-backoff retries. Typed errors — `SearchTimeoutError`,
`SearchConnectionError`, `SearchHTTPError` (all extend `SearchClientError`), plus `SearchParseError` — let
you branch on the failure mode.

The enums (`SeatType`, `MaxStops`, `SortBy`, `TripType`, `Alliance`, `EmissionsFilter`) match the Python
names exactly; see [python-api.md](python-api.md) for the value lists.
