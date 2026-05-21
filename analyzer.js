import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

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
    return html.slice(0, 15000);
  } catch (err) {
    console.error(`  Fetch failed: ${err.message}`);
    return null;
  }
}

async function analyzeWebsite(html, businessName, website) {
  const prompt = `
You are an expert web consultant. Analyze this website HTML for "${businessName}" (${website}).

Return ONLY a valid JSON object with this exact structure, no extra text:
{
  "performance_issues": ["issue1", "issue2"],
  "accessibility_issues": ["issue1", "issue2"],
  "seo_issues": ["issue1", "issue2"],
  "ai_readability_issues": ["issue1", "issue2"],
  "overall_quality": "poor|average|good",
  "top_3_improvements": ["improvement1", "improvement2", "improvement3"],
  "opportunity_score": <integer 1-10, where 10 means most room for improvement>
}

HTML:
${html}
`;

  try {
    const response = await fetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model: "qwen/qwen3.5-397b-a17b",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000,
          temperature: 0.3,
        }),
      },
    );

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";

    // Strip <think>...</think> blocks (Qwen chain-of-thought) and markdown fences
    const clean = text
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/```json|```/g, "")
      .trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`No JSON found in AI response for ${businessName}. Raw: ${text.slice(0, 200)}`);
      return null;
    }
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`AI analysis failed for ${businessName}:`, err.message);
    return null;
  }
}

async function runAnalyzer() {
  console.log("Fetching pending leads...");

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, business_name, website")
    .in("audit_status", ["pending", "processing"])
    .not("website", "is", null)
    .limit(20); // Process 20 at a time

  if (error) {
    console.error("Error fetching leads:", error.message);
    return;
  }

  console.log(`Found ${leads.length} leads to analyze`);

  for (const lead of leads) {
    console.log(`\nAnalyzing: ${lead.business_name} | ${lead.website}`);

    // Mark as processing
    await supabase
      .from("leads")
      .update({ audit_status: "processing" })
      .eq("id", lead.id);

    const html = await fetchWebsiteHTML(lead.website);

    if (!html) {
      await supabase
        .from("leads")
        .update({ audit_status: "failed" })
        .eq("id", lead.id);
      continue;
    }

    const audit = await analyzeWebsite(html, lead.business_name, lead.website);

    if (!audit) {
      await supabase
        .from("leads")
        .update({ audit_status: "failed" })
        .eq("id", lead.id);
      continue;
    }

    const { error: updateError } = await supabase
      .from("leads")
      .update({
        audit,
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
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("\nAnalysis complete.");
}

runAnalyzer();
