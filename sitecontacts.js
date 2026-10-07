// Finds a business's own contact email on its website, without a browser.
// Visits the home page and up to three contact/about pages, honours
// robots.txt, and identifies itself with a descriptive user agent.

import * as cheerio from "cheerio";

export const USER_AGENT =
  "Mozilla/5.0 (compatible; RefactrixLeadFinder/1.0; +https://www.refactrix.com)";
const ROBOTS_AGENT = "refactrixleadfinder";

const PAGE_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 1_500_000;
const MAX_EXTRA_PAGES = 3;

const EMAIL_RE = /[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,24}/g;

// Words that mark a contact or about link, including common non-English ones
const CONTACT_LINK_RE =
  /contact|get-?in-?touch|enquir|inquir|about|impressum|kontakt|contacto|contatti|nous-contacter|over-ons/i;
const FALLBACK_PATHS = ["/contact", "/contact-us"];

const PREFERRED_LOCAL_PARTS = new Set([
  "info", "contact", "hello", "enquiries", "enquiry", "admin", "sales",
  "office", "team", "bookings", "reservations", "mail",
]);
const SKIP_LOCAL_PARTS = /^(no-?reply|do-?not-?reply|postmaster|abuse|webmaster|privacy|gdpr|dpo|unsubscribe)$/i;
// Hiring inboxes: a pitch there reaches whoever handles recruitment
const JOB_LOCAL_PARTS = /jobs?|careers?|recruit|vacanc|hiring|^hr$/i;
const PLACEHOLDER_DOMAINS = /(^|\.)(example\.(com|org|net)|domain\.com|yourdomain\.|email\.com|sentry\.io|wixpress\.com)$/i;
const FILE_LIKE = /\.(png|jpe?g|gif|webp|svg|ico|css|js)$/i;

export const hostOf = (s = "") =>
  s.toLowerCase().trim().replace(/^https?:\/\//, "").split(/[/?#:]/)[0].replace(/^www\./, "");

// Websites that aren't the business's own site, so there is nothing to audit
const NOT_OWN_SITE = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com", "youtube.com",
  "linkedin.com", "linktr.ee", "wa.me", "google.com", "business.site", "yell.com",
  "tripadvisor.com", "tripadvisor.co.uk", "booksy.com", "fresha.com", "treatwell.co.uk",
  "ubereats.com", "deliveroo.co.uk", "just-eat.co.uk", "opentable.com", "opentable.co.uk",
  "mymenuweb.com",
];
export const isOwnSite = (domain) => !NOT_OWN_SITE.some((d) => domain === d || domain.endsWith("." + d));
/**
 * Whether a URL is still on the site's own domain (or a subdomain either
 * way). Domains lapse and get bought: a restaurant's address can end up
 * redirecting to a betting site, which must not be audited or emailed.
 */
export function sameSite(url, site) {
  const a = hostOf(url);
  const b = hostOf(site);
  if (!a || !b) return false;
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

// Words too common in business names to show a page is about this business
const GENERIC_NAME_WORDS = new Set([
  "the", "and", "of", "ltd", "limited", "co", "uk", "london", "restaurant", "restaurants",
  "cafe", "café", "bar", "salon", "hair", "beauty", "clinic", "dental", "gym", "studio",
  "plumbing", "heating", "services", "service", "shop", "store", "kitchen", "group",
]);

const normalize = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Whether a page is about this business: its name, or every distinctive word
 * of it, appears in the page's title or text. Used when a website redirects to
 * another domain, to tell a rebrand from a domain that now belongs to someone
 * else.
 */
export function pageMentionsName(html, name) {
  if (!html || !name) return false;
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const text = ` ${normalize(`${$("title").text()} ${$("body").text()}`)} `;
  const full = normalize(name.split("|")[0]);
  if (full && text.includes(` ${full} `)) return true;
  const words = full.split(" ").filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  return words.length > 0 && words.every((w) => text.includes(` ${w} `));
}

/** Same rule emailgen.js applies before drafting. */
export function emailMatchesSite(email, site) {
  const e = hostOf(email.split("@")[1]);
  const s = hostOf(site);
  if (!e || !s) return false;
  return e === s || e.endsWith("." + s) || s.endsWith("." + e);
}

/** Cleans a website tag into an absolute http(s) URL, or null. */
export function normalizeWebsite(raw) {
  if (!raw) return null;
  let s = String(raw).split(/[;\s]/)[0].trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".")) return null;
    u.hash = "";
    u.search = "";
    return u.href;
  } catch {
    return null;
  }
}

// ─── robots.txt ──────────────────────────────────────────────────────────────

function ruleToRegex(path) {
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + (escaped.endsWith("\\$") ? escaped.slice(0, -2) + "$" : escaped));
}

/** Returns a function telling whether a path may be fetched. */
async function loadRobots(origin) {
  let text = "";
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) text = (await res.text()).slice(0, 200_000);
  } catch {
    // No robots.txt reachable: everything is allowed
  }

  // Groups of user agents with their rules; ours wins over "*"
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.replace(/#.*/, "").split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      if (value) current.rules.push({ allow: key === "allow", path: value, re: ruleToRegex(value) });
      lastWasAgent = false;
    } else if (key) {
      lastWasAgent = false;
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a && ROBOTS_AGENT.includes(a) && a !== "*"));
  const rules = (ours.length ? ours : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);

  // Longest matching rule wins; Allow wins a tie
  return (path) => {
    let best = null;
    for (const r of rules) {
      if (!r.re.test(path)) continue;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
    return !best || best.allow;
  };
}

// ─── Pages ───────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!res.ok) return { status: res.status, url: res.url };
  if (!(res.headers.get("content-type") || "").includes("html")) return { status: res.status, url: res.url };
  const html = (await res.text()).slice(0, MAX_HTML_BYTES);
  return { status: res.status, url: res.url, html };
}

// Cloudflare hides addresses as hex in data-cfemail: first byte is the XOR key
function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch {
    return "";
  }
}

function emailsInPage($) {
  const found = [];
  $("a[href^='mailto:' i]").each((_, el) => {
    const addr = decodeURIComponent(($(el).attr("href") || "").slice(7).split("?")[0]);
    found.push(...addr.split(","));
  });
  $("[data-cfemail]").each((_, el) => found.push(decodeCfEmail($(el).attr("data-cfemail") || "")));
  $("script, style, noscript").remove();
  // A space before every tag keeps text from neighbouring elements apart;
  // otherwise "0161 555 7127" + "info@x.co.uk" reads as 7127info@x.co.uk
  const text = cheerio.load(($("body").html() || "").replace(/</g, " <")).text();
  found.push(...(text.match(EMAIL_RE) || []));
  return found;
}

function contactLinks($, pageUrl) {
  const base = new URL(pageUrl);
  const links = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim().slice(0, 60);
    if (!CONTACT_LINK_RE.test(href) && !CONTACT_LINK_RE.test(text)) return;
    try {
      const u = new URL(href, base);
      if (hostOf(u.hostname) !== hostOf(base.hostname) || !u.protocol.startsWith("http")) return;
      u.hash = "";
      if (u.href !== base.href) links.add(u.href);
    } catch {
      // Unparseable link
    }
  });
  return [...links];
}

function cleanCandidates(raw, website) {
  const out = new Map();
  for (const r of raw) {
    const email = String(r).trim().replace(/^[.\-_]+|[.\-_]+$/g, "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(email)) continue;
    const [local, domain] = email.split("@");
    if (SKIP_LOCAL_PARTS.test(local) || JOB_LOCAL_PARTS.test(local)) continue;
    if (PLACEHOLDER_DOMAINS.test(domain) || FILE_LIKE.test(email)) continue;
    if (/^\d+$/.test(local) || local.length > 40) continue;
    if (!emailMatchesSite(email, website)) continue;
    const score = (PREFERRED_LOCAL_PARTS.has(local) ? 3 : 1) + (hostOf(domain) === hostOf(website) ? 2 : 0);
    out.set(email, Math.max(out.get(email) ?? 0, score));
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([email]) => email);
}

/**
 * Looks for the business's own address (same domain as its website).
 * `known` holds addresses already listed for the place (e.g. its OSM tags);
 * `name` is the business name, used to check a site that redirects elsewhere.
 * Returns { emails, outcome, website } where outcome is
 * found | no_email | blocked | unreachable | moved, and website is the site's
 * current address when it has moved to a new domain (a rebrand).
 */
export async function findSiteEmails(website, known = [], name = "") {
  let fromTags = cleanCandidates(known, website);
  let movedTo = null;
  const start = new URL(website);
  const allowed = await loadRobots(start.origin);

  // Map listings often point at an old deep link; fall back to the home page
  const entries = [...new Set([start.href, `${start.origin}/`])].filter((u) => allowed(new URL(u).pathname));
  if (!entries.length) {
    // robots.txt keeps us off the site, so a listed address is all there is
    return fromTags.length ? { emails: fromTags, outcome: "found" } : { emails: [], outcome: "blocked" };
  }

  let home = null;
  let lastStatus = 0;
  for (const url of entries) {
    try {
      const page = await fetchHtml(url);
      if (page.url && !sameSite(page.url, website)) {
        // A rebrand keeps the business's name; a lapsed domain doesn't
        if (!page.html || !pageMentionsName(page.html, name)) return { emails: [], outcome: "moved" };
        website = movedTo = `${new URL(page.url).origin}/`;
        fromTags = cleanCandidates(known, website);
      }
      if (page.html) {
        home = page;
        break;
      }
      lastStatus = page.status;
    } catch {
      // Network or TLS error: try the next entry
    }
  }
  // A site that blocks bots can still have a listed address worth using
  if (fromTags.length) return { emails: fromTags, outcome: "found", ...(movedTo && { website: movedTo }) };
  if (!home) return { emails: [], outcome: lastStatus === 403 || lastStatus === 429 ? "blocked" : "unreachable" };

  const raw = [];
  const $home = cheerio.load(home.html);
  const links = contactLinks($home, home.url);
  raw.push(...emailsInPage($home));

  let found = cleanCandidates(raw, website);
  if (found.length) return { emails: found, outcome: "found", ...(movedTo && { website: movedTo }) };

  const origin = new URL(home.url).origin;
  const queue = links.length ? links : FALLBACK_PATHS.map((p) => origin + p);
  for (const url of queue.slice(0, MAX_EXTRA_PAGES)) {
    if (!allowed(new URL(url).pathname)) continue;
    try {
      const page = await fetchHtml(url);
      if (!page.html) continue;
      raw.push(...emailsInPage(cheerio.load(page.html)));
    } catch {
      continue;
    }
    found = cleanCandidates(raw, website);
    if (found.length) return { emails: found, outcome: "found", ...(movedTo && { website: movedTo }) };
  }
  return { emails: [], outcome: "no_email" };
}
