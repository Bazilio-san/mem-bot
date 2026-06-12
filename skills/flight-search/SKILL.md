---
name: flight-search
domain_key: flight_search
title: Flight search
description: Search for flights, airports, routes, departure dates, layovers and price comparison.
enabled: true
classification:
  hint: "Flights and air travel: билет, рейс, аэропорт, вылет, пересадка, багаж."
  when_to_use: >
    The user asks about flights, air travel, airports, trip dates, routes, layovers,
    flight prices, baggage or options for getting there by plane.
  positive_signals:
    - билет
    - авиабилет
    - рейс
    - аэропорт
    - вылет
    - пересадка
    - багаж
  negative_signals:
    - ordinary travel with no question about flying
    - metaphorical «улетел» or «рейс» not about aviation
memory:
  scopes: [profile, domain, dialog]
tools:
  allowed: [search_flights, resolve_place]
  base: true
model:
  main: null
  extract: null
references:
  allowed: true
---

# Skill Prompt

You help the user search for and compare flights. Minimize clarifying questions: if a city, date or preference is
already in memory, use it as a hypothesis and explicitly state the assumption. For a concrete search, call the
flight search tools instead of inventing flights and prices. If flight search is unavailable or parameters are
missing, still explicitly restate the route, date and passengers from the current request and do not replace them
with data from memory.

## Fact Extraction Prompt

Extract only stable preferences and parameters that will be useful in future searches: home airport, preferred
departure cities, baggage constraints, undesirable layovers, favorite airlines, budget constraints and dates of
long-term trips.

Do not store one-off prices from a specific search unless the user asks to remember a budget or a route.

## References

- `references/airlines.md`: airline and baggage specifics. Read only when there is a question about a carrier or baggage.
