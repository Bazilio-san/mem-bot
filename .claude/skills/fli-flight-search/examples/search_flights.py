#!/usr/bin/env python3
"""Search flights with Fli and print the cheapest priced options.

Run:
    pip install flights        # requires Python >= 3.10
    python search_flights.py

Edit ORIGIN / DESTINATION / DAYS_AHEAD / cabin / stops at the top to change the search.
Booking purchases are not performed — each result carries a deep-link booking URL instead.
"""

from datetime import datetime, timedelta

from fli.models import (
    Airport,
    FlightSearchFilters,
    FlightSegment,
    MaxStops,
    PassengerInfo,
    SeatType,
    SortBy,
)
from fli.search import SearchFlights

ORIGIN = Airport.JFK
DESTINATION = Airport.LAX
DAYS_AHEAD = 30  # travel_date must be in the future and within ~305 days


def main() -> None:
    travel_date = (datetime.now() + timedelta(days=DAYS_AHEAD)).strftime("%Y-%m-%d")

    filters = FlightSearchFilters(
        passenger_info=PassengerInfo(adults=1),
        flight_segments=[
            FlightSegment(
                departure_airport=[[ORIGIN, 0]],
                arrival_airport=[[DESTINATION, 0]],
                travel_date=travel_date,
            )
        ],
        seat_type=SeatType.ECONOMY,
        stops=MaxStops.NON_STOP,
        sort_by=SortBy.CHEAPEST,
    )

    search = SearchFlights()
    # search() returns None when there are no results — always guard.
    results = search.search(filters) or []

    # Prices can be missing (premium-cabin round-trips, etc.); skip priceless rows
    # before sorting or comparing.
    priced = [f for f in results if not f.price_unknown]
    if not priced:
        print(f"No priced flights found for {ORIGIN.name} → {DESTINATION.name} on {travel_date}.")
        return

    print(f"{ORIGIN.name} → {DESTINATION.name} on {travel_date} — cheapest options:\n")
    for flight in sorted(priced, key=lambda f: f.price)[:5]:
        legs = " → ".join(f"{leg.airline.value}{leg.flight_number}" for leg in flight.legs)
        url = search.build_flight_booking_url(flight, currency="USD")
        print(f"${flight.price:>7.0f}  {flight.duration:>4} min  {flight.stops} stop(s)  {legs}")
        print(f"          book: {url}")


if __name__ == "__main__":
    main()
