import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Max pages to crawl per site — prevents infinite loops on large sites
const MAX_PAGES = 20;

// Page timeout per page
const PAGE_TIMEOUT = 12000;

// Email domains to ignore — platform/generic addresses, not real business emails
const IGNORED_EMAIL_DOMAINS = [
  "sentry.io", "wixpress.com", "squarespace.com", "shopify.com",
  "googletagmanager.com", "google.com", "facebook.com", "instagram.com",
  "twitter.com", "tiktok.com", "youtube.com", "example.com", "domain.com",
  "email.com", "yourname.com", "name.com", "wordpress.com", "wp.com",
  "cloudflare.com", "amazonaws.com", "w3.org", "schema.org",
];

// High-priority pages to visit first before general crawl
const PRIORITY_PATHS = [
  "/contact", "/contact-us", "/about", "/about-us", "/get-in-touch",
  "/reach-us", "/reach-out", "/enquiry", "/enquiries", "/help",
  "/privacy", "/privacy-policy", "/terms", "/terms-and-conditions",
  "/cookies", "/cookie-policy", "/legal",
];

// Strict email regex — must have valid TLD (2-10 chars), no file extensions
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,255}\.[a-zA-Z]{2,10}\b/g;

// File extensions to skip — images, docs, scripts, feeds
const SKIP_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|mp4|mp3|woff|woff2|ttf|css|js|xml|json|rss|atom)(\?|#|$)/i;

function extractEmails(text) {
  const raw = text.match(EMAIL_REGEX) || [];
  return raw.filter((email) => {
    const [local, domain] = email.split("@");
    if (!domain) return false;
    // Skip if domain is in ignore list
    if (IGNORED_EMAIL_DOMAINS.some((d) => domain.toLowerCase().includes(d))) return false;
    // Skip obvious image/file paths that match regex (e.g. background@2x.png)
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|css|js)$/i.test(domain)) return false;
    // Must have at least one dot in domain
    if (!domain.includes(".")) return false;
    // Local part sanity — skip if it's just numbers or looks like a version
    if (/^\d+$/.test(local)) return false;
    return true;
  });
}

function rankEmails(emails, siteDomain) {
  const baseDomain = siteDomain.replace(/^www\./, "").split(".")[0].toLowerCase();

  const domainScore = (e) => {
    const d = e.split("@")[1]?.toLowerCase() || "";
    // Exact domain match is strongest
    if (d === siteDomain.toLowerCase()) return 20;
    // Partial match (subdomain or similar)
    if (d.includes(baseDomain)) return 10;
    return 0;
  };

  const prefixScore = (e) => {
    const local = e.split("@")[0].toLowerCase();
    const topPrefixes = ["info", "contact", "hello", "enquiries", "enquiry", "admin", "sales", "support", "mail", "office", "team"];
    if (topPrefixes.includes(local)) return 3;
    return 1;
  };

  return [...new Set(emails.map(e => e.toLowerCase()))].sort(
    (a, b) => (domainScore(b) + prefixScore(b)) - (domainScore(a) + prefixScore(a))
  );
}

function isSameDomain(href, siteDomain) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    const base = siteDomain.replace(/^www\./, "");
    return host === base || host.endsWith("." + base);
  } catch {
    return false;
  }
}

function normalizeUrl(href, base) {
  try {
    const url = new URL(href, base);
    // Drop hash fragments and common tracking params
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function crawlSiteForEmails(page, website) {
  const siteDomain = website.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  const allEmails = [];
  const visited = new Set();
  const queue = [];

  // Load homepage first
  try {
    await page.goto(website, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(1200);
  } catch {
    return null; // site is down or unreachable
  }

  const homepageHtml = await page.content();
  allEmails.push(...extractEmails(homepageHtml));
  visited.add(website.replace(/\/$/, ""));

  // If homepage already gives us a strong domain-matched email, stop here
  const earlyRank = rankEmails(allEmails, siteDomain);
  if (earlyRank.length > 0 && earlyRank[0].split("@")[1]?.toLowerCase().includes(siteDomain.replace(/^www\./, "").split(".")[0])) {
    console.log(`  (found on homepage)`);
    return earlyRank[0];
  }

  // Collect all internal links from homepage
  const homepageLinks = await page.$$eval("a[href]", (els) =>
    els.map((el) => el.href).filter(Boolean)
  ).catch(() => []);

  // Sort: priority paths first, then everything else
  const prioritized = [];
  const rest = [];
  for (const href of homepageLinks) {
    if (SKIP_EXTENSIONS.test(href)) continue;
    const normalized = normalizeUrl(href, website);
    if (!normalized || !isSameDomain(normalized, siteDomain)) continue;
    if (visited.has(normalized)) continue;

    const path = new URL(normalized).pathname.toLowerCase();
    const isPriority = PRIORITY_PATHS.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
    if (isPriority) prioritized.push(normalized);
    else rest.push(normalized);
  }

  queue.push(...prioritized, ...rest);

  // BFS crawl up to MAX_PAGES
  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
      await page.waitForTimeout(800);

      const html = await page.content();
      const found = extractEmails(html);
      allEmails.push(...found);

      if (found.length > 0) {
        const path = new URL(url).pathname;
        console.log(`  (found on ${path})`);
      }

      // Check if we now have a strong match — stop early
      const ranked = rankEmails(allEmails, siteDomain);
      if (ranked.length > 0 && ranked[0].split("@")[1]?.toLowerCase().includes(siteDomain.replace(/^www\./, "").split(".")[0])) {
        break;
      }

      // Collect new internal links from this page
      if (visited.size < MAX_PAGES) {
        const links = await page.$$eval("a[href]", (els) =>
          els.map((el) => el.href).filter(Boolean)
        ).catch(() => []);

        for (const href of links) {
          if (SKIP_EXTENSIONS.test(href)) continue;
          const normalized = normalizeUrl(href, url);
          if (!normalized || !isSameDomain(normalized, siteDomain)) continue;
          if (!visited.has(normalized) && !queue.includes(normalized)) {
            const path = new URL(normalized).pathname.toLowerCase();
            const isPriority = PRIORITY_PATHS.some((p) => path === p || path.startsWith(p + "/"));
            if (isPriority) queue.unshift(normalized); // jump to front
            else queue.push(normalized);
          }
        }
      }
    } catch {
      continue;
    }
  }

  console.log(`  (crawled ${visited.size} pages)`);
  const final = rankEmails(allEmails, siteDomain);
  return final[0] || null;
}

async function runEmailScraper() {
  console.log("Fetching leads with missing emails...\n");

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, business_name, website, domain")
    .is("email", null)
    .not("website", "is", null)
    .eq("audit_status", "done")
    .gte("opportunity_score", 6)
    .limit(50);

  if (error) { console.error("Supabase error:", error.message); return; }
  if (!leads || leads.length === 0) { console.log("No leads with missing emails found."); return; }

  console.log(`Found ${leads.length} leads to scan.\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Block images, fonts, and media to speed up crawling
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) route.abort();
    else route.continue();
  });

  let found = 0;
  let notFound = 0;

  for (const lead of leads) {
    console.log(`\nScanning: ${lead.business_name}`);
    console.log(`  Site: ${lead.website}`);

    const email = await crawlSiteForEmails(page, lead.website);

    if (email) {
      const { error: updateError } = await supabase
        .from("leads")
        .update({ email })
        .eq("id", lead.id);

      if (updateError) {
        console.log(`  DB error: ${updateError.message}`);
      } else {
        console.log(`  ✓ ${email}`);
        found++;
      }
    } else {
      console.log(`  ✗ No email found`);
      notFound++;
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  await browser.close();

  console.log(`\n${"─".repeat(40)}`);
  console.log(`Emails found:   ${found}`);
  console.log(`No email found: ${notFound}`);
}

runEmailScraper();
