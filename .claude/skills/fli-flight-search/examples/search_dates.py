#!/usr/bin/env python3
"""Find the cheapest travel dates for a route within a flexible window.

Run:
    pip install flights        # requires Python >= 3.10
    python search_dates.py

Date ranges larger than 61 days are split into multiple calls automatically; you
cannot search more than ~305 days ahead. Set IS_ROUND_TRIP / TRIP_DURATION for round trips.
"""

from datetime import datetime, timedelta

from fli.models import (
    Airport,
    DateSearchFilters,
    FlightSegment,
    PassengerInfo,
)
from fli.search import SearchDates

ORIGIN = Airport.JFK
DESTINATION = Airport.LHR
WINDOW_START_DAYS = 30   # first day of the search window, days from today
WINDOW_LENGTH_DAYS = 45  # window width (auto-split if > 61)
IS_ROUND_TRIP = False
TRIP_DURATION = 7        # days; only used when IS_ROUND_TRIP is True


def main() -> None:
    start = datetime.now() + timedelta(days=WINDOW_START_DAYS)
    end = start + timedelta(days=WINDOW_LENGTH_DAYS)
    from_date = start.strftime("%Y-%m-%d")
    to_date = end.strftime("%Y-%m-%d")

    filters = DateSearchFilters(
        passenger_info=PassengerInfo(adults=1),
        flight_segments=[
            FlightSegment(
                departure_airport=[[ORIGIN, 0]],
                arrival_airport=[[DESTINATION, 0]],
                travel_date=from_date,
            )
        ],
        from_date=from_date,
        to_date=to_date,
        duration=TRIP_DURATION if IS_ROUND_TRIP else None,
    )

    results = SearchDates().search(filters) or []
    if not results:
        print(f"No dated prices found for {ORIGIN.name} → {DESTINATION.name} "
              f"between {from_date} and {to_date}.")
        return

    print(f"{ORIGIN.name} → {DESTINATION.name}, {from_date} … {to_date} — cheapest dates:\n")
    for dp in sorted(results, key=lambda d: d.price)[:10]:
        # dp.date is (outbound,) one-way or (outbound, return) round-trip.
        out = dp.date[0].date()
        ret = f" → back {dp.date[1].date()}" if len(dp.date) > 1 else ""
        print(f"{out}{ret}  ${dp.price:>7.0f} {dp.currency or ''}")


if __name__ == "__main__":
    main()
