import "./redact-logs.js";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
import { CATEGORIES } from "./categories.js";
import { findSiteEmails, hostOf, isOwnSite, normalizeWebsite } from "./sitecontacts.js";

// Optional, local-only extra source: searches Google Maps in a headless
// Playwright browser. Run Leads.cmd asks before running it (default: no).
//
// Scraping Google Maps is against Google's terms of service. The owner chose
// to use it knowingly, from this PC and at low volume; it is not run on
// GitHub. The main source is leadfinder.js (OpenStreetMap).
//
// Searches are taken from the admin's search areas (lead_targets), picked at
// random. Leads are saved with the same rules as leadfinder.js: an email on
// the business's own domain only, the suppression list checked, the country
// set, and every checked place recorded so it is never visited twice.

const MAX_NEW_LEADS = Math.min(Math.max(parseInt(process.env.MAX_NEW_LEADS ?? "15", 10) || 15, 1), 50);
const SEARCHES_PER_RUN = 3;
const MAX_PLACES_PER_SEARCH = 40;
const SCROLLS = 8;
const SHOW_BROWSER = process.env.SHOW_BROWSER === "1";

const COUNTRY_NAMES = { GB: "UK", IE: "Ireland", US: "USA", AU: "Australia", CA: "Canada", NZ: "New Zealand" };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DatabaseError extends Error {}

/** Google's place id, e.g. 0x4870bc8c21bacf5f:0x2670ecc7f4775849, from a place link. */
const placeId = (href) => (href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || [])[1] ?? null;

/** Website links sometimes go through google.com/url?q=… */
function realWebsite(href) {
  try {
    const u = new URL(href);
    if (hostOf(u.hostname).startsWith("google.") && u.searchParams.get("q")) return u.searchParams.get("q");
  } catch {
    // Not a URL
  }
  return href;
}

// ─── Database ────────────────────────────────────────────────────────────────

async function pickSearches() {
  const { data, error } = await supabase
    .from("lead_targets")
    .select("country, area, category")
    .eq("enabled", true);
  if (error) throw new DatabaseError(`Loading search areas failed: ${error.message}`);
  const usable = data.filter((t) => CATEGORIES[t.category]);
  // Random picks, so repeated runs spread across areas and categories
  for (let i = usable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [usable[i], usable[j]] = [usable[j], usable[i]];
  }
  return usable.slice(0, SEARCHES_PER_RUN);
}

async function loadKnownDomains() {
  const domains = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("leads").select("domain").range(from, from + 999);
    if (error) throw new DatabaseError(`Loading lead domains failed: ${error.message}`);
    for (const r of data) if (r.domain) domains.add(hostOf(r.domain));
    if (data.length < 1000) break;
  }
  return domains;
}

async function loadSeen(ids) {
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("lead_sources_seen")
      .select("source_id")
      .eq("source", "google_maps")
      .in("source_id", ids.slice(i, i + 200));
    if (error) throw new DatabaseError(`Loading checked places failed: ${error.message}`);
    for (const r of data) seen.add(r.source_id);
  }
  return seen;
}

async function markSeen(sourceId, outcome) {
  const { error } = await supabase
    .from("lead_sources_seen")
    .upsert({ source: "google_maps", source_id: sourceId, outcome, checked_at: new Date().toISOString() });
  if (error) console.error(`  Could not record ${sourceId}: ${error.message}`);
}

async function isSuppressed(emails) {
  const { data, error } = await supabase.from("suppressions").select("email").in("email", emails);
  if (error) throw new DatabaseError(`Reading suppressions failed: ${error.message}`);
  return data.length > 0;
}

// ─── Google Maps ─────────────────────────────────────────────────────────────

async function dismissConsent(page) {
  const reject = page.locator('button:has-text("Reject all")').first();
  if (await reject.isVisible({ timeout: 3000 }).catch(() => false)) {
    await reject.click();
    await page.waitForTimeout(2000);
  }
}

async function listPlaces(page, query) {
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await dismissConsent(page);
  const feed = await page.waitForSelector('div[role="feed"]', { timeout: 20_000 }).catch(() => null);
  if (!feed) return [];
  for (let i = 0; i < SCROLLS; i++) {
    await page.evaluate(() => document.querySelector('div[role="feed"]')?.scrollBy(0, 1000));
    await page.waitForTimeout(1500);
  }
  const links = await page.$$eval('div[role="feed"] > div > div > a', (els) =>
    els.map((el) => ({ name: el.getAttribute("aria-label"), href: el.href })),
  );
  return links
    .map((l) => ({ ...l, id: placeId(l.href) }))
    .filter((l) => l.name && l.id);
}

async function readPlace(page, href) {
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);
  const website = await page.$eval('a[data-item-id="authority"]', (el) => el.href).catch(() => null);
  const phone = await page
    .$eval('button[data-item-id*="phone"]', (el) => el.getAttribute("aria-label") || el.textContent)
    .catch(() => null);
  return {
    website: website ? normalizeWebsite(realWebsite(website)) : null,
    phone: phone ? phone.replace(/^Phone:\s*/i, "").trim() : null,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Google Maps: up to ${MAX_NEW_LEADS} new leads from ${SEARCHES_PER_RUN} searches`);
  const searches = await pickSearches();
  if (!searches.length) {
    console.log("No search areas. Add some on the Automation page.");
    return;
  }
  const knownDomains = await loadKnownDomains();

  const browser = await chromium.launch({ headless: !SHOW_BROWSER });
  const page = await browser.newPage({ locale: "en-GB" });
  let found = 0;
  let checked = 0;

  try {
    for (const t of searches) {
      if (found >= MAX_NEW_LEADS) break;
      const query = `${CATEGORIES[t.category].label} in ${t.area} ${COUNTRY_NAMES[t.country] ?? t.country}`;
      console.log(`\nSearching Google Maps: ${query}`);

      const places = await listPlaces(page, query);
      const seen = await loadSeen(places.map((p) => p.id));
      const fresh = places.filter((p) => !seen.has(p.id)).slice(0, MAX_PLACES_PER_SEARCH);
      console.log(`  ${places.length} places listed, ${fresh.length} not checked yet`);
      if (!places.length) console.log("  (No results: Google may be showing a check page. Try again later.)");

      for (const place of fresh) {
        if (found >= MAX_NEW_LEADS) break;
        checked++;
        let { website, phone } = await readPlace(page, place.href).catch(() => ({ website: null, phone: null }));
        if (!website) {
          console.log(`  – ${place.name}: no website`);
          await markSeen(place.id, "no_website");
          continue;
        }
        let domain = hostOf(website);
        if (!isOwnSite(domain)) {
          console.log(`  – ${place.name}: website is a social or booking page`);
          await markSeen(place.id, "no_website");
          continue;
        }
        if (knownDomains.has(domain)) {
          await markSeen(place.id, "duplicate");
          continue;
        }

        const result = await findSiteEmails(website, [], place.name).catch(() => ({ emails: [], outcome: "unreachable" }));
        const { emails, outcome } = result;
        // The site moved to a new domain (a rebrand): save the current one
        if (result.website) {
          website = result.website;
          domain = hostOf(website);
          if (knownDomains.has(domain)) {
            await markSeen(place.id, "duplicate");
            continue;
          }
        }
        if (outcome !== "found") {
          console.log(`  – ${place.name}: ${outcome.replace("_", " ")}`);
          await markSeen(place.id, outcome);
          continue;
        }
        if (await isSuppressed(emails)) {
          console.log(`  – ${place.name}: unsubscribed earlier`);
          await markSeen(place.id, "suppressed");
          continue;
        }

        knownDomains.add(domain);
        const { error } = await supabase.from("leads").insert({
          business_name: place.name.trim(),
          website,
          domain,
          email: emails[0],
          emails,
          phone,
          city: t.area,
          country: t.country,
          category: t.category,
          google_maps_url: place.href,
          source: "google_maps",
          source_id: place.id,
          audit_status: "pending",
        });
        if (error?.code === "23505") {
          console.log(`  – ${place.name}: already a lead`);
          await markSeen(place.id, "duplicate");
          continue;
        }
        if (error) throw new DatabaseError(`Saving a lead failed: ${error.message}`);
        found++;
        console.log(`  ✓ ${place.name} → ${emails[0]}`);
        await markSeen(place.id, "lead");
        await sleep(500);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${found} new leads from ${checked} places checked.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
