// Countries whose leads may be drafted and emailed.
//
// The lead finder can search any country, so leads can be collected ahead of
// time. Drafting (emailgen.js) and sending (sendapproved.js) only handle
// leads from the countries listed here; everything else waits.
//
// Adding a country is a legal decision, not a config tweak. Rules on
// unsolicited business email differ a lot. A rough summary, not legal advice:
//   GB  PECR: allowed to company addresses with a clear opt-out. Sole traders
//       and some partnerships count as individuals and need prior consent.
//   US  CAN-SPAM: allowed, but every email must carry a valid postal address.
//   CA  CASL: needs consent; a published address only implies it when the
//       message is relevant to the recipient's role.
//   AU  Spam Act: needs consent; a conspicuously published address can imply
//       it when the message relates to their business.
//   DE  UWG: prior consent needed, even for business addresses.
// Check the country's rules, update emailgen.js / sendapproved.js if they
// need anything extra (e.g. a postal address), then add it here.

export const SEND_COUNTRIES = {
  GB: { name: "United Kingdom", language: "British English" },
};

export const SEND_COUNTRY_CODES = Object.keys(SEND_COUNTRIES);
