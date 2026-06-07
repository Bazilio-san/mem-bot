export const searchFlightsTool = {
  name: 'search_flights',
  title: 'Поиск авиабилетов',
  definition: {
    type: 'function',
    function: {
      name: 'search_flights',
      description: 'Search flight offers by route and date for the flight_search domain.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['origin', 'destination', 'date'],
        properties: {
          origin: { type: 'string', description: 'Departure city or airport.' },
          destination: { type: 'string', description: 'Arrival city or airport.' },
          date: { type: ['string', 'null'], description: 'Departure date, or null for flexible dates.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    return {
      route: `${args.origin} → ${args.destination}`,
      date: args.date || 'ближайшие даты',
      offers: [
        { flight: 'SU 1234', depart: '08:40', arrive: '11:10', price_rub: 7450, night: false },
        { flight: 'U6 221', depart: '23:15', arrive: '01:55', price_rub: 5300, night: true },
      ],
    };
  },
};
