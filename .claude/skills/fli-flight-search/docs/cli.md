# CLI (`fli`)

Install with pipx so the command lands on PATH in an isolated environment:

```bash
pipx install flights          # exposes `fli`, `fli-mcp`, `fli-mcp-http`
fli --help
```

If `fli` is "command not found" right after install, run `python3 -m pipx ensurepath` and restart the shell.

The CLI has four subcommands: `flights`, `dates`, `airports`, `multi`. A bare invocation whose first argument
is not a known subcommand is treated as a `flights` search (`fli JFK LAX 2026-05-15` ≡
`fli flights JFK LAX 2026-05-15`) — prefer the explicit subcommand in scripts and examples.

## `fli flights` — search a date

```bash
# Positional: ORIGIN DESTINATION DATE
fli flights JFK LAX 2026-10-25

# Round-trip and filters
fli flights JFK LHR 2026-10-25 \
  --return 2026-10-30 \
  --time 6-20 \              # departure window, 6 AM – 8 PM local
  --airlines BA,KL \         # include British Airways, KLM
  --class BUSINESS \         # cabin class
  --stops NON_STOP \         # ANY | NON_STOP | ONE_STOP | TWO_PLUS_STOPS
  --sort DURATION            # CHEAPEST | DURATION | DEPARTURE_TIME | ARRIVAL_TIME

# Alliances, exclusions, layover bounds, locale
fli flights JFK LHR 2026-10-25 \
  --alliance ONEWORLD \
  --exclude-airlines AA \
  --min-layover 90 --max-layover 360 \
  --currency EUR --language en-GB --country GB
```

| Option                   | Short | Meaning                                        | Example            |
|--------------------------|-------|------------------------------------------------|--------------------|
| `--return`               | `-r`  | Return date (makes it round-trip)              | `2026-10-30`       |
| `--time`                 | `-t`  | Departure time window `HH-HH`                  | `6-20`             |
| `--airlines`             | `-a`  | Include airline IATA codes                     | `BA,KL`            |
| `--exclude-airlines`     | `-A`  | Exclude airline IATA codes                     | `DL,B6`            |
| `--alliance`             |       | Restrict to alliance(s)                        | `ONEWORLD`         |
| `--exclude-alliance`     |       | Exclude alliance(s)                            | `STAR_ALLIANCE`    |
| `--min-layover`          |       | Minimum layover, minutes                       | `90`               |
| `--max-layover`          |       | Maximum layover, minutes                       | `360`              |
| `--currency`             |       | ISO 4217 currency code                         | `EUR`              |
| `--language`             |       | BCP-47 language code (`hl`)                     | `en-GB`            |
| `--country`              |       | ISO 3166-1 alpha-2 country (`gl`)              | `GB`               |
| `--class`                | `-c`  | Cabin class                                    | `ECONOMY`, `BUSINESS` |
| `--stops`                | `-s`  | Maximum stops                                  | `NON_STOP`         |
| `--sort`                 | `-o`  | Sort order                                     | `CHEAPEST`         |
| `--format`               |       | Output format `text` or `json` (experimental)  | `json`             |

## `fli dates` — cheapest dates in a window

```bash
fli dates JFK LHR --from 2026-01-01 --to 2026-01-31
fli dates JFK LHR --from 2026-01-01 --to 2026-02-01 --monday --friday   # only Mon/Fri departures
fli dates JFK LHR --from 2026-01-01 --to 2026-01-31 --round --duration 7 # round-trip, 7-day trips
```

Adds `--from`, `--to` (date range), `--duration`/`-d` (trip length in days), `--round`/`-R` (round-trip),
per-weekday flags (`--monday` … `--sunday`), and `--sort` (sort by price). It shares the airline/alliance/
layover/locale/class/stops/time options with `fli flights`.

## `fli airports` — resolve a place to IATA codes

```bash
fli airports "new york"     # JFK, LGA, EWR
fli airports heathrow       # LHR
fli airports JFK            # confirms the code
```

Use this first when the user gives a city name rather than a code.

## `fli multi` — multi-city itineraries

```bash
# Each --leg is ORIGIN,DEST,DATE
fli multi --leg SEA,HKG,2026-12-26 --leg PEK,SEA,2027-01-02

fli multi \
  -l SEA,NRT,2026-12-26 \
  -l NRT,HKG,2026-12-30 \
  -l HKG,SEA,2027-01-05 \
  --class BUSINESS --stops NON_STOP --sort CHEAPEST
```

## Machine-readable output (experimental)

```bash
fli flights JFK LHR 2026-10-25 --format json | jq '.flights[0]'
fli dates JFK LHR --from 2026-01-01 --to 2026-01-31 --format json
```

`--format json` is **experimental** — the schema may change between releases. For a stable contract, prefer
the Python/TS library or the MCP server. If you must shell out from an agent, pin the Fli version.

## Notes for agents that shell out

- Exit non-zero on failure; capture stderr for the human-readable error.
- A past `DATE` is rejected (`travel_date` must be in the future); dates beyond ~305 days also fail.
- Live Google requests can fail transiently — retry once after a short delay before reporting a hard error.
