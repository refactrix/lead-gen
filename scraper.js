import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// ─── Email extraction helpers (lightweight version for scraper) ───────────────

const EMAIL_REGEX = /\b[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,255}\.[a-zA-Z]{2,10}\b/g;

const IGNORED_EMAIL_DOMAINS = new Set([
  "sentry.io", "wixpress.com", "squarespace.com", "shopify.com",
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "google.com", "facebook.com", "twitter.com", "youtube.com",
  "example.com", "wordpress.com", "cloudflare.com", "amazonaws.com",
  "w3.org", "schema.org", "apple.com", "microsoft.com",
]);

const PRIORITY_PATHS = [
  "/contact", "/contact-us", "/contacts", "/get-in-touch",
  "/about", "/about-us", "/reach-us", "/help",
];

const PREFERRED_PREFIXES = new Set([
  "info", "contact", "hello", "enquiries", "enquiry",
  "admin", "sales", "support", "mail", "office", "team",
]);

function extractEmails(text) {
  const matches = text.match(EMAIL_REGEX) || [];
  return matches.filter((e) => !IGNORED_EMAIL_DOMAINS.has(e.split("@")[1]?.toLowerCase()));
}

function rankEmails(emails, domain) {
  const scored = emails.map((email) => {
    const [local, emailDomain] = email.toLowerCase().split("@");
    let score = 0;
    if (emailDomain === domain) score += 20;
    else if (domain.includes(emailDomain) || emailDomain.includes(domain.split(".")[0])) score += 10;
    if (PREFERRED_PREFIXES.has(local)) score += 3;
    else score += 1;
    return { email, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function findEmailForSite(emailPage, website, domain) {
  const visited = new Set();
  const emailSet = new Set();

  try {
    await emailPage.goto(website, { waitUntil: "domcontentloaded", timeout: 12000 });
    const homeText = await emailPage.content().catch(() => "");
    extractEmails(homeText).forEach((e) => emailSet.add(e));
    visited.add(website);

    // Check for early strong match
    const homeRanked = rankEmails([...emailSet], domain);
    if (homeRanked.length && homeRanked[0].score >= 20) {
      return homeRanked[0].email;
    }

    // Crawl priority pages
    const base = new URL(website).origin;
    for (const path of PRIORITY_PATHS) {
      const pageUrl = base + path;
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);

      try {
        const resp = await emailPage.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
        if (!resp || !resp.ok()) continue;
        const text = await emailPage.content().catch(() => "");
        extractEmails(text).forEach((e) => emailSet.add(e));
      } catch {
        // page not found — skip
      }

      const ranked = rankEmails([...emailSet], domain);
      if (ranked.length && ranked[0].score >= 20) return ranked[0].email;
    }
  } catch {
    // site unreachable
  }

  const ranked = rankEmails([...emailSet], domain);
  return ranked.length ? ranked[0].email : null;
}

const SEARCH_QUERIES = [
  "restaurant London UK",
  "cafe Manchester UK",
  "salon Birmingham UK",
  "plumber Bristol UK",
  "gym Leeds UK",
];

function normalizeMapUrl(url) {
  try {
    return url
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  } catch {
    return url;
  }
}

function extractDomain(url) {
  try {
    return url
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
  } catch {
    return url;
  }
}

async function fetchExisting() {
  console.log("Fetching existing leads from Supabase...");
  const { data, error } = await supabase
    .from("leads")
    .select("google_maps_url, domain");

  if (error) {
    console.error("Error fetching existing leads:", error.message);
    return { urlSet: new Set(), domainSet: new Set() };
  }

  const urlSet = new Set(
    data.map((row) => normalizeMapUrl(row.google_maps_url)),
  );
  const domainSet = new Set(
    data.filter((row) => row.domain).map((row) => row.domain),
  );

  console.log(
    `Loaded ${urlSet.size} map URLs and ${domainSet.size} domains into memory`,
  );
  return { urlSet, domainSet };
}

async function scrapeLeads() {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  const emailPage = await browser.newPage();

  // Block images/fonts on the email crawl page to speed it up
  await emailPage.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media", "stylesheet"].includes(type)) route.abort();
    else route.continue();
  });

  console.log("Browser launched");

  const { urlSet: existingUrls, domainSet: existingDomains } =
    await fetchExisting();

  const newLeads = [];

  for (const query of SEARCH_QUERIES) {
    console.log("\nSearching:", query);
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);

    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 1000);
      });
      await page.waitForTimeout(1500);
    }

    const places = await page.$$eval(
      'div[role="feed"] > div > div > a',
      (els) =>
        els.map((el) => ({
          name: el.getAttribute("aria-label"),
          href: el.href,
        })),
    );

    console.log(`Found ${places.length} places for: ${query}`);

    for (const place of places) {
      if (!place.name || !place.href) continue;

      const normalizedMapUrl = normalizeMapUrl(place.href);

      // Skip if map URL already exists
      if (existingUrls.has(normalizedMapUrl)) {
        console.log("Skipping duplicate map URL:", place.name);
        continue;
      }

      await page.goto(place.href, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(2500);

      const website = await page
        .$eval('a[data-item-id="authority"]', (el) => el.href)
        .catch(() => null);

      const phone = await page
        .$eval('button[data-item-id*="phone"]', (el) => el.textContent)
        .catch(() => null);

      const address = await page
        .$eval('button[data-item-id="address"]', (el) => el.textContent)
        .catch(() => null);

      // Always mark map URL as seen
      existingUrls.add(normalizedMapUrl);

      if (!website) {
        console.log("No website, skipping:", place.name);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(3000);
        continue;
      }

      const domain = extractDomain(website);

      // Skip if domain already exists
      if (existingDomains.has(domain)) {
        console.log("Skipping duplicate domain:", place.name, "|", domain);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(3000);
        continue;
      }

      console.log(`New lead: ${place.name} | ${domain}`);

      // Find email by crawling the business website
      const email = await findEmailForSite(emailPage, website.trim(), domain);
      if (email) console.log(`  → Email found: ${email}`);
      else console.log(`  → No email found`);

      newLeads.push({
        business_name: place.name.trim(),
        website: website.trim(),
        domain,
        phone: phone?.trim() || null,
        city: address?.trim() || null,
        category: query,
        google_maps_url: place.href,
        google_maps_url_normalized: normalizedMapUrl,
        email: email || null,
      });

      // Mark as seen in memory
      existingUrls.add(normalizedMapUrl);
      existingDomains.add(domain);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
    }
  }

  await browser.close();

  console.log(`\nScraping done. ${newLeads.length} new leads found.`);

  if (newLeads.length === 0) {
    console.log("Nothing to insert.");
    return;
  }

  const { error } = await supabase.from("leads").insert(newLeads);

  if (error) {
    console.error("Batch insert error:", error.message);
  } else {
    console.log(`Successfully saved ${newLeads.length} leads to Supabase.`);
  }
}

scrapeLeads();
