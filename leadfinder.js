import "./redact-logs.js";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
import { CATEGORIES } from "./categories.js";
import { findSiteEmails, hostOf, normalizeWebsite } from "./sitecontacts.js";

// Finds new leads from OpenStreetMap (data © OpenStreetMap contributors, ODbL).
//
// Search areas live in the lead_targets table (country + area + category),
// managed in the admin. Each run takes the areas searched longest ago, lists
// the matching places that have a website via the Overpass API, and checks
// each new place's website for the business's own email address. Places with
// one become leads (audit_status pending) for analyzer.js.
//
// An area is "exhausted" once every listed place has been checked; it is
// searched again after REVISIT_DAYS, since new places are mapped all the time.

const MAX_NEW_LEADS = Math.min(Math.max(parseInt(process.env.MAX_NEW_LEADS ?? "30", 10) || 30, 1), 100);
const MAX_AREAS_PER_RUN = 6;
const MAX_CHECKS_PER_AREA = 60; // websites visited per area per run
const CONCURRENCY = 4;
// The workflow step is killed at 30 minutes; one slow map query can take ~2
const TIME_BUDGET_MS = 20 * 60_000;
const REVISIT_DAYS = 90;
const RECHECK_DAYS = 180; // places without a usable email are checked again after this

// OpenStreetMap services want an app name and contact. overpass-api.de
// answers 406 to browser-style user agents ("Mozilla/5.0 (compatible; …)").
const OSM_USER_AGENT = "RefactrixLeadFinder/1.0 (+https://www.refactrix.com; mohit.j@refactrix.com)";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Websites that aren't the business's own site, so there is nothing to audit
const NOT_OWN_SITE = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com", "youtube.com",
  "linkedin.com", "linktr.ee", "wa.me", "google.com", "business.site", "yell.com",
  "tripadvisor.com", "tripadvisor.co.uk", "booksy.com", "fresha.com", "treatwell.co.uk",
  "ubereats.com", "deliveroo.co.uk", "just-eat.co.uk", "opentable.com", "opentable.co.uk",
];
const isOwnSite = (domain) => !NOT_OWN_SITE.some((d) => domain === d || domain.endsWith("." + d));
// The same website on this many places in one area means a chain or a directory
const CHAIN_THRESHOLD = 3;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const startedAt = Date.now();
const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

// A database failure stops the run: carrying on would record places as
// checked without saving them as leads.
class DatabaseError extends Error {}

// ─── OpenStreetMap ───────────────────────────────────────────────────────────

/** Finds the area's boundary in OSM (Nominatim: max 1 request per second). */
async function resolveArea(target) {
  const params = new URLSearchParams({
    q: target.area,
    countrycodes: target.country.toLowerCase(),
    format: "jsonv2",
    limit: "5",
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { "User-Agent": OSM_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  await sleep(1100);
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const hit = (await res.json()).find(
    (r) => r.osm_type === "relation" && ["boundary", "place"].includes(r.category),
  );
  if (!hit) return null;
  // Overpass area ids for relations are offset by 3600000000
  return { osmAreaId: 3_600_000_000 + Number(hit.osm_id), name: hit.display_name };
}

async function overpass(query) {
  let lastError;
  // The main server twice, then each mirror once; mirrors are often overloaded
  const attempts = [OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[0], ...OVERPASS_ENDPOINTS.slice(1)];
  for (const [i, endpoint] of attempts.entries()) {
    if (outOfTime()) break;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent": OSM_USER_AGENT,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(100_000),
      });
      const text = await res.text();
      if (!res.ok || !text.startsWith("{")) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(text);
      // A query that ran out of time still answers 200, with a remark
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
      return json.elements;
    } catch (err) {
      lastError = err;
      console.warn(`  Overpass ${new URL(endpoint).host} failed (${err.message})`);
      if (i < attempts.length - 1) await sleep(10_000);
    }
  }
  throw new Error(`All Overpass servers failed: ${lastError?.message}`);
}

async function listPlaces(target) {
  const tags = CATEGORIES[target.category].tags;
  const parts = tags.flatMap(([k, v]) =>
    ["website", "contact:website"].map((w) => `nwr["${k}"="${v}"]["${w}"](area.a);`),
  );
  const query = `[out:json][timeout:90];area(id:${target.osm_area_id})->.a;(${parts.join("")});out tags;`;
  return overpass(query);
}

/** Turns OSM elements into candidate places, dropping chains and non-sites. */
function toCandidates(elements) {
  const places = [];
  for (const el of elements) {
    const t = el.tags || {};
    const name = (t.name || "").trim();
    const website = normalizeWebsite(t.website || t["contact:website"]);
    if (!name || !website) continue;
    if (t.brand || t["brand:wikidata"]) continue; // chains
    const domain = hostOf(website);
    if (!isOwnSite(domain)) continue;
    places.push({
      sourceId: `${el.type}/${el.id}`,
      name,
      website,
      domain,
      phone: (t.phone || t["contact:phone"] || "").split(";")[0].trim() || null,
      city: t["addr:city"] || null,
      emails: [t.email, t["contact:email"]].filter(Boolean).flatMap((e) => e.split(";")),
    });
  }
  const perDomain = new Map();
  for (const p of places) perDomain.set(p.domain, (perDomain.get(p.domain) ?? 0) + 1);
  return places.filter((p) => perDomain.get(p.domain) < CHAIN_THRESHOLD);
}

// ─── Database ────────────────────────────────────────────────────────────────

async function loadKnownDomains() {
  const domains = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("leads").select("domain").range(from, from + 999);
    if (error) throw new Error(`Loading lead domains failed: ${error.message}`);
    for (const r of data) if (r.domain) domains.add(hostOf(r.domain));
    if (data.length < 1000) break;
  }
  return domains;
}

/** Source ids already checked, minus no-email outcomes old enough to retry. */
async function loadSeen(sourceIds) {
  const seen = new Set();
  const recheckBefore = daysAgo(RECHECK_DAYS);
  for (let i = 0; i < sourceIds.length; i += 200) {
    const { data, error } = await supabase
      .from("lead_sources_seen")
      .select("source_id, outcome, checked_at")
      .eq("source", "osm")
      .in("source_id", sourceIds.slice(i, i + 200));
    if (error) throw new Error(`Loading checked places failed: ${error.message}`);
    for (const r of data) {
      const retry = ["no_email", "unreachable", "error"].includes(r.outcome) && r.checked_at < recheckBefore;
      if (!retry) seen.add(r.source_id);
    }
  }
  return seen;
}

async function markSeen(sourceIds, outcome) {
  const ids = [].concat(sourceIds);
  const checked_at = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await supabase
      .from("lead_sources_seen")
      .upsert(ids.slice(i, i + 500).map((source_id) => ({ source: "osm", source_id, outcome, checked_at })));
    if (error) console.error(`  Could not record checked places: ${error.message}`);
  }
}

async function isSuppressed(emails) {
  const { data, error } = await supabase.from("suppressions").select("email").in("email", emails);
  if (error) throw new DatabaseError(`Reading suppressions failed: ${error.message}`);
  return data.length > 0;
}

async function updateTarget(id, fields) {
  const { error } = await supabase.from("lead_targets").update(fields).eq("id", id);
  if (error) console.error(`  Could not update search area ${id}: ${error.message}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function searchArea(target, knownDomains, quota) {
  const label = `${CATEGORIES[target.category]?.label ?? target.category} in ${target.area}, ${target.country}`;
  console.log(`\nSearching: ${label}`);

  if (!CATEGORIES[target.category]) {
    await updateTarget(target.id, { last_run_at: new Date().toISOString(), last_error: "Unknown category" });
    return { found: 0, checked: 0 };
  }

  if (!target.osm_area_id) {
    const area = await resolveArea(target);
    if (!area) {
      console.log("  Area not found in OpenStreetMap — check the name");
      await updateTarget(target.id, { last_run_at: new Date().toISOString(), last_error: "Area not found in OpenStreetMap" });
      return { found: 0, checked: 0 };
    }
    target.osm_area_id = area.osmAreaId;
    await updateTarget(target.id, { osm_area_id: area.osmAreaId, resolved_name: area.name });
    console.log(`  Area: ${area.name}`);
  }

  const candidates = toCandidates(await listPlaces(target));
  const seen = await loadSeen(candidates.map((c) => c.sourceId));
  const fresh = [];
  const duplicates = [];
  for (const c of candidates) {
    if (seen.has(c.sourceId)) continue;
    if (knownDomains.has(c.domain)) duplicates.push(c.sourceId);
    else fresh.push(c);
  }
  if (duplicates.length) await markSeen(duplicates, "duplicate");
  console.log(`  ${candidates.length} independent places with websites, ${fresh.length} not checked yet`);

  const queue = fresh.slice(0, MAX_CHECKS_PER_AREA);
  let found = 0;
  let inFlight = 0; // places being checked right now, so 4 workers can't overshoot the quota
  let checked = 0;
  let failure = null;

  async function worker() {
    try {
      while (queue.length && found + inFlight < quota && !outOfTime() && !failure) {
        inFlight++;
        try {
          await checkPlace(queue.shift());
        } finally {
          inFlight--;
        }
      }
    } catch (err) {
      failure ??= err;
    }
  }

  async function checkPlace(place) {
    // Another worker may have just added a lead for the same domain
    if (knownDomains.has(place.domain)) {
      await markSeen(place.sourceId, "duplicate");
      return;
    }
    checked++;
    const { emails, outcome } = await findSiteEmails(place.website, place.emails).catch(() => ({
      emails: [],
      outcome: "unreachable",
    }));
    if (outcome !== "found") {
      console.log(`  – ${place.name}: ${outcome.replace("_", " ")}`);
      await markSeen(place.sourceId, outcome);
      return;
    }
    if (await isSuppressed(emails)) {
      console.log(`  – ${place.name}: unsubscribed earlier`);
      await markSeen(place.sourceId, "suppressed");
      return;
    }

    knownDomains.add(place.domain);
    const { error } = await supabase.from("leads").insert({
      business_name: place.name,
      website: place.website,
      domain: place.domain,
      email: emails[0],
      emails,
      phone: place.phone,
      city: place.city || target.area,
      country: target.country,
      category: target.category,
      source: "osm",
      source_id: place.sourceId,
      audit_status: "pending",
    });
    if (error?.code === "23505") {
      console.log(`  – ${place.name}: already a lead`);
      await markSeen(place.sourceId, "duplicate");
      return;
    }
    if (error) {
      // Not recorded as checked, so this place is tried again next run
      knownDomains.delete(place.domain);
      throw new DatabaseError(`Saving a lead failed: ${error.message}`);
    }
    found++;
    console.log(`  ✓ ${place.name} → ${emails[0]}`);
    await markSeen(place.sourceId, "lead");
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failure) throw failure;

  // Places taken off the queue were all recorded, whatever the outcome
  const remaining = fresh.length - (Math.min(fresh.length, MAX_CHECKS_PER_AREA) - queue.length);
  await updateTarget(target.id, {
    last_run_at: new Date().toISOString(),
    exhausted_at: remaining <= 0 ? new Date().toISOString() : null,
    leads_found: target.leads_found + found,
    places_checked: target.places_checked + checked,
    last_error: null,
  });
  console.log(`  ${found} new lead${found === 1 ? "" : "s"} from ${checked} websites${remaining <= 0 ? " — area fully checked" : ""}`);
  return { found, checked };
}

async function main() {
  console.log(`Lead finder: up to ${MAX_NEW_LEADS} new leads this run`);

  const { data: targets, error } = await supabase
    .from("lead_targets")
    .select("*")
    .eq("enabled", true)
    .or(`exhausted_at.is.null,exhausted_at.lt."${daysAgo(REVISIT_DAYS)}"`)
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .order("priority", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_AREAS_PER_RUN);

  if (error) throw new Error(`Loading search areas failed: ${error.message}`);
  if (!targets.length) {
    console.log("No search areas to run. Add some on the Automation page.");
    return;
  }

  const knownDomains = await loadKnownDomains();
  let total = 0;
  let checked = 0;
  let searched = 0;
  let failed = 0;

  for (const target of targets) {
    if (total >= MAX_NEW_LEADS || outOfTime()) break;
    try {
      const r = await searchArea(target, knownDomains, MAX_NEW_LEADS - total);
      total += r.found;
      checked += r.checked;
      searched++;
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      // Not marked exhausted, so it comes round again after the other areas
      console.error(`  Search failed: ${err.message}`);
      await updateTarget(target.id, { last_run_at: new Date().toISOString(), last_error: err.message.slice(0, 300) });
      failed++;
    }
  }

  // A busy map server failing one area is normal; only flag the run when
  // no area could be searched at all
  if (failed && !searched) process.exitCode = 1;

  console.log(`\nDone. ${total} new leads from ${checked} websites checked.`);
  if (outOfTime()) console.log("Stopped at the time limit; the rest continues next run.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
