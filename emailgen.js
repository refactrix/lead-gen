import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function extractJSON(text) {
  if (!text) return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function generateEmail(lead) {
  const audit = lead.audit || {};

  const prompt = `You are writing a cold outreach email on behalf of Mohit Jeswani, the founder of Refactrix — a premium software engineering studio that helps startups and SMEs in the UK and India build scalable, maintainable software.

Refactrix services: custom software development, architecture consulting, legacy modernisation, product engineering, AI automation, and ongoing engineering support.

About the recipient:
Business: ${lead.business_name}
Website: ${lead.website}

Website audit findings:
- Performance issues: ${audit.performance_issues?.join(", ") || "none"}
- SEO issues: ${audit.seo_issues?.join(", ") || "none"}
- Accessibility issues: ${audit.accessibility_issues?.join(", ") || "none"}
- Top 3 improvements: ${audit.top_3_improvements?.join(", ") || "none"}
- Overall quality: ${audit.overall_quality || "not assessed"}

Write a short, friendly, and casual cold email from Mohit to the business owner.

Rules:
- Do not be salesy or pushy
- Mention 1-2 specific issues found on their website naturally
- Keep it under 150 words
- Position Mohit as the founder of Refactrix (not a freelancer)
- Reference Refactrix subtly — credibility, not a pitch
- End with a soft call to action (a quick call or reply)
- Do not use generic phrases like "I hope this email finds you well"
- Sound like a real human founder, not a robot
- Sign off as:
  Mohit Jeswani
  Founder, Refactrix
  refactrix.com

Return ONLY a valid JSON object, no extra text, no markdown:
{
  "subject": "email subject here",
  "body": "full email body here including the signature"
}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    max_tokens: 1024,
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.choices[0]?.message?.content || null;
  const email = extractJSON(text);

  if (!email || !email.subject || !email.body) {
    throw new Error(`Malformed response: ${text?.slice(0, 200)}`);
  }

  return email;
}

async function runEmailGen() {
  console.log("Starting email generation...\n");

  // Reset any stuck 'processing' rows from previous interrupted runs
  await supabase
    .from("leads")
    .update({ email_status: "pending" })
    .eq("email_status", "processing");

  let totalGenerated = 0;
  let totalFailed = 0;

  while (true) {
    const { data: leads, error } = await supabase
      .from("leads")
      .select("*")
      .eq("audit_status", "done")
      .eq("email_status", "pending")
      .gte("opportunity_score", 6)
      .limit(10);

    if (error) {
      console.error("Supabase error:", error.message);
      break;
    }

    if (!leads || leads.length === 0) {
      console.log("\nNo more eligible leads to process.");
      break;
    }

    for (const lead of leads) {
      console.log(`\nProcessing: ${lead.business_name}`);

      await supabase
        .from("leads")
        .update({ email_status: "processing" })
        .eq("id", lead.id);

      try {
        const email = await generateEmail(lead);

        const { error: updateError } = await supabase
          .from("leads")
          .update({
            email_subject: email.subject,
            email_body: email.body,
            email_status: "ready",
          })
          .eq("id", lead.id);

        if (updateError) {
          throw new Error(`DB update failed: ${updateError.message}`);
        }

        console.log(`  Done: "${email.subject}"`);
        totalGenerated++;
      } catch (err) {
        const { error: failError } = await supabase
          .from("leads")
          .update({ email_status: "failed" })
          .eq("id", lead.id);

        if (failError) {
          console.error(`  DB fail update error: ${failError.message}`);
        }

        console.error(`  Failed: ${err.message}`);
        totalFailed++;
      }

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Generated: ${totalGenerated}`);
  console.log(`  Failed:    ${totalFailed}`);
}

runEmailGen();