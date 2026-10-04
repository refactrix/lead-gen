// Business categories the lead finder searches for, as OpenStreetMap tags.
// A place matches a category if it has any of the listed key=value tags.
// See https://wiki.openstreetmap.org/wiki/Map_features for more tags.
//
// Keys are stored in leads.category and lead_targets.category. The admin's
// list in refactrix/web lib/lead-categories.ts must use the same keys.

export const CATEGORIES = {
  restaurant: { label: "Restaurants", tags: [["amenity", "restaurant"]] },
  cafe: { label: "Cafés", tags: [["amenity", "cafe"]] },
  bakery: { label: "Bakeries", tags: [["shop", "bakery"]] },
  hairdresser: { label: "Hairdressers & barbers", tags: [["shop", "hairdresser"]] },
  beauty_salon: { label: "Beauty salons", tags: [["shop", "beauty"]] },
  gym: { label: "Gyms & fitness studios", tags: [["leisure", "fitness_centre"]] },
  dentist: { label: "Dentists", tags: [["amenity", "dentist"], ["healthcare", "dentist"]] },
  physio: { label: "Physiotherapists", tags: [["healthcare", "physiotherapist"]] },
  vet: { label: "Vets", tags: [["amenity", "veterinary"]] },
  plumber: { label: "Plumbers", tags: [["craft", "plumber"]] },
  electrician: { label: "Electricians", tags: [["craft", "electrician"]] },
  builder: { label: "Builders", tags: [["craft", "builder"]] },
  car_repair: { label: "Garages & car repair", tags: [["shop", "car_repair"]] },
  accountant: { label: "Accountants", tags: [["office", "accountant"]] },
  solicitor: { label: "Solicitors & law firms", tags: [["office", "lawyer"]] },
  estate_agent: { label: "Estate agents", tags: [["office", "estate_agent"]] },
  florist: { label: "Florists", tags: [["shop", "florist"]] },
  clothes: { label: "Clothes shops", tags: [["shop", "clothes"], ["shop", "boutique"]] },
  hotel: { label: "Hotels & B&Bs", tags: [["tourism", "hotel"], ["tourism", "guest_house"]] },
};
