import "./redact-logs.js";
import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
dotenv.config();
import Groq from "groq-sdk";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MAX_ATTEMPTS = 3;

// Facts read straight from the HTML, so the email can state them as findings.
// Wording carries no numbers, because the email must not quote any.
function measureHtml($, finalUrl, bodyText) {
  const checks = {
    https: finalUrl.startsWith("https://"),
    has_title: $("head title").first().text().trim().length > 0,
    has_meta_description: $("meta")
      .filter((_, el) => ($(el).attr("name") || "").toLowerCase() === "description")
      .toArray()
      .some((el) => ($(el).attr("content") || "").trim().length > 0),
    has_viewport: $("meta")
      .toArray()
      .some((el) => ($(el).attr("name") || "").toLowerCase() === "viewport"),
    has_lang: ($("html").attr("lang") || "").trim().length > 0,
    h1_count: $("h1").length,
    images: $("img").length,
    images_missing_alt: $("img:not([alt])").length,
    // Pages rendered by JavaScript arrive nearly empty, so heading and image
    // checks would report false problems; they only count when text came back.
    server_rendered: bodyText.length >= 200,
  };

  const issues = [];
  if (!checks.https) issues.push("The site does not load over HTTPS, so browsers may mark it as not secure");
  if (!checks.has_title) issues.push("The homepage has no page title");
  if (!checks.has_meta_description) issues.push("The homepage has no meta description, so search engines choose their own snippet");
  if (!checks.has_viewport) issues.push("There is no mobile viewport tag, so the page may not scale properly on phones");
  if (!checks.has_lang) issues.push("The page does not declare its language, which screen readers use");
  if (checks.server_rendered && checks.h1_count === 0) issues.push("The homepage has no main heading (H1)");
  if (checks.server_rendered && checks.images_missing_alt > 0) issues.push("Some images have no alt text, which screen readers and search engines rely on");

  return { checks, issues };
}

async function fetchWebsiteHTML(url) {
  try {
    // Clean UTM params from URL
    const cleanUrl = url.split("?")[0];
    console.log(`  Fetching HTML from: ${cleanUrl}`);

    const response = await fetch(cleanUrl, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      console.log(`  HTTP ${response.status} for ${cleanUrl}`);
      return null;
    }

    const html = await response.text();
    console.log(`  Fetched ${html.length} chars`);
    const $ = cheerio.load(html);

    // Visible text, used for both the render check and the model prompt
    const $text = cheerio.load(html);
    $text("script, style, svg, img").remove(); // strip noise
    const text = $text("body").text().replace(/\s+/g, " ").trim();

    const measured = measureHtml($, response.url || cleanUrl, text);
    return { text: text.slice(0, 4000), measured }; // clean text is far more token-efficient
  } catch (err) {
    console.error(`  Fetch failed: ${err.message}`);
    return null;
  }
}

async function analyzeWebsite(html, measuredIssues, businessName, website) {
  const systemPrompt = `You are a web consultant. You must respond with ONLY a valid JSON object — no explanation, no markdown, no code fences, no extra text. Just the raw JSON.`;

  const userPrompt = `Analyze this website text for "${businessName}" (${website}). You only have the visible text: you cannot see images, styling or load speed, so do not report on them.

Issues already confirmed from the page's HTML:
${measuredIssues.map((m) => `- ${m}`).join("\n") || "- none"}

Return a JSON object with this exact structure:
{
  "performance_issues": ["issue1", "issue2"],
  "accessibility_issues": ["issue1", "issue2"],
  "seo_issues": ["issue1", "issue2"],
  "ai_readability_issues": ["issue1", "issue2"],
  "overall_quality": "poor|average|good",
  "top_3_improvements": ["improvement1", "improvement2", "improvement3"],
  "opportunity_score": <integer 1-10, where 10 means most room for improvement>
}

Page text:
${html}`;

  try {
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const text = completion.choices?.[0]?.message?.content || "";

    // Strip <think>...</think> blocks (Qwen chain-of-thought) and markdown fences
    const clean = text
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/```json|```/g, "")
      .trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(
        `No JSON found in AI response for ${businessName}. Raw: ${text.slice(0, 200)}`,
      );
      return null;
    }
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`AI analysis failed for ${businessName}:`, err.message);
    return null;
  }
}

// The workflow step is stopped at 15 minutes; an audit takes about 15 seconds
const TIME_BUDGET_MS = 11 * 60_000;
const BATCH = 20;

const validScore = (n) => Number.isInteger(n) && n >= 1 && n <= 10;

async function runAnalyzer() {
  const startedAt = Date.now();
  // Each lead is tried at most once per run, so a failure isn't retried at once
  const tried = new Set();
  let total = 0;

  // Batch after batch until the queue is empty, so a big lead finder run
  // doesn't wait hours for later runs
  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    console.log("Fetching pending leads...");

    const { data, error } = await supabase
      .from("leads")
      .select("id, business_name, website, audit_attempts")
      .in("audit_status", ["pending", "processing", "failed"])
      .lt("audit_attempts", MAX_ATTEMPTS)
      .not("website", "is", null)
      .order("created_at", { ascending: true })
      .limit(BATCH + tried.size);

    if (error) {
      console.error("Error fetching leads:", error.message);
      process.exitCode = 1;
      return;
    }

    const leads = data.filter((l) => !tried.has(l.id)).slice(0, BATCH);
    console.log(`Found ${leads.length} leads to analyze`);
    if (!leads.length) break;

    for (const lead of leads) {
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
      tried.add(lead.id);
      total++;
      await analyzeLead(lead);
    }
  }

  if (Date.now() - startedAt >= TIME_BUDGET_MS) {
    console.log("\nStopped at the time limit; the rest are audited next run.");
  }
  console.log(`\nAnalysis complete. ${total} leads audited this run.`);
}

async function analyzeLead(lead) {
  console.log(`\nAnalyzing: ${lead.business_name} | ${lead.website}`);

  // Mark as processing
  await supabase
    .from("leads")
    .update({ audit_status: "processing" })
    .eq("id", lead.id);

  // Failed rows are retried on later runs until MAX_ATTEMPTS is reached
  const markFailed = () =>
    supabase
      .from("leads")
      .update({
        audit_status: "failed",
        audit_attempts: (lead.audit_attempts ?? 0) + 1,
      })
      .eq("id", lead.id);

  const page = await fetchWebsiteHTML(lead.website);

  if (!page) {
    await markFailed();
    return;
  }

  const audit = await analyzeWebsite(
    page.text,
    page.measured.issues,
    lead.business_name,
    lead.website,
  );

  // Without a usable score the lead could never be drafted, so it's retried
  if (!audit || !validScore(audit.opportunity_score)) {
    if (audit) console.error(`  No valid opportunity score for ${lead.business_name}`);
    await markFailed();
    return;
  }

  const { error: updateError } = await supabase
    .from("leads")
    .update({
      audit: {
        ...audit,
        measured_issues: page.measured.issues,
        checks: page.measured.checks,
      },
      opportunity_score: audit.opportunity_score,
      audit_status: "done",
    })
    .eq("id", lead.id);

  if (updateError) {
    console.error("Update error:", updateError.message);
  } else {
    console.log(
      `Done: ${lead.business_name} | Score: ${audit.opportunity_score}/10`,
    );
  }

  // Small delay to avoid rate limiting
  await new Promise((r) => setTimeout(r, 4000));
}

runAnalyzer();
