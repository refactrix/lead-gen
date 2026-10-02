import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── HTML template ───────────────────────────────────────────────────────────
function buildHtml({
  businessName,
  domain,
  opening,
  issue1,
  issue2,
  issue3,
  closing,
  calendarLink,
}) {
  const ICON_COLORS = ["#fdf4ff", "#f0fdf4", "#eff6ff"];
  const ICONS = ["⚡", "🔍", "📱"];

  const issues = [issue1, issue2, issue3];

  const issueRows = issues
    .map(
      (issue, i) => `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:${i < 2 ? "18px" : "32px"};">
      <tr>
        <td width="40" valign="top" style="padding-top:2px;">
          <div style="width:34px;height:34px;background:${ICON_COLORS[i]};border-radius:10px;text-align:center;line-height:34px;font-size:17px;">${ICONS[i]}</div>
        </td>
        <td style="padding-left:14px;" valign="top">
          <p style="margin:0 0 3px 0;font-size:14px;font-weight:600;color:#18181b;">${issue.title}</p>
          <p style="margin:0;font-size:13px;color:#52525b;line-height:1.6;">${issue.detail}</p>
        </td>
      </tr>
    </table>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f8f8fb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8fb;padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">

          <!-- LOGO -->
          <tr>
            <td style="padding:0 0 24px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background:#6366f1;width:3px;border-radius:2px;">&nbsp;</td>
                        <td style="padding-left:14px;">
                          <span style="font-size:20px;font-weight:700;color:#0f0f0f;letter-spacing:-0.5px;">refactrix</span><span style="font-size:20px;font-weight:700;color:#6366f1;">.</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right">
                    <span style="font-size:11px;color:#a1a1aa;letter-spacing:0.8px;text-transform:uppercase;font-weight:500;">Software Engineering</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CARD -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;border:1px solid #e8e8ed;">
              <div style="background:#6366f1;height:4px;"></div>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:40px 44px 36px 44px;">

                    <p style="margin:0 0 8px 0;font-size:15px;font-weight:600;color:#18181b;">Hi ${businessName},</p>

                    <p style="margin:0 0 32px 0;font-size:15px;color:#52525b;line-height:1.75;">${opening}</p>

                    <p style="margin:0 0 14px 0;font-size:11px;font-weight:600;color:#6366f1;letter-spacing:1.2px;text-transform:uppercase;">What we found on ${domain}</p>
                    <div style="background:#e8e8ed;height:1px;margin:0 0 20px 0;"></div>

                    ${issueRows}

                    <div style="background:#e8e8ed;height:1px;margin:0 0 28px 0;"></div>

                    <p style="margin:0 0 28px 0;font-size:15px;color:#52525b;line-height:1.75;">${closing}</p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:36px;">
                      <tr>
                        <td align="center">
                          <table cellpadding="0" cellspacing="0">
                            <tr>
                              <td style="background:#6366f1;border-radius:10px;">
                                <a href="${calendarLink}" style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Book a free 15-min call &nbsp;→</a>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="border-top:1px solid #e8e8ed;padding-top:24px;">
                          <p style="margin:0;font-size:14px;color:#52525b;line-height:1.8;">
                            Best,<br />
                            <span style="font-weight:600;color:#18181b;font-size:15px;">Mohit Jeswani</span><br />
                            <span style="color:#52525b;font-size:13px;">Founder, Refactrix</span><br />
                            <a href="https://refactrix.com" style="color:#6366f1;text-decoration:none;font-size:13px;">refactrix.com</a>
                          </p>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding:20px 0 0 0;">
              <p style="margin:0;font-size:11px;color:#a1a1aa;text-align:center;line-height:1.8;">
                Refactrix &nbsp;·&nbsp; refactrix.com<br />
                You're receiving this because we think we can genuinely help.&nbsp;
                <a href="mailto:mohit.j@refactrix.com?subject=Unsubscribe" style="color:#a1a1aa;text-decoration:underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Groq: generate email content ────────────────────────────────────────────

function extractJSON(text) {
  if (!text) return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    const sanitized = match[0].replace(/(?<=":[\s]*"[^"]*)\n/g, "\\n");
    try {
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

async function generateEmailContent(lead) {
  const audit = lead.audit || {};
  const improvements = audit.top_3_improvements || [];
  const perfIssues = audit.performance_issues || [];
  const seoIssues = audit.seo_issues || [];
  const accessIssues = audit.accessibility_issues || [];

  const prompt = `You are writing content for a cold outreach HTML email from Mohit Jeswani, Founder of Refactrix — a software engineering studio helping UK businesses improve their websites.

Business: ${lead.business_name}
Website: ${lead.website}
Domain: ${lead.domain || lead.website}

Audit findings:
- Performance: ${perfIssues.join(", ") || "none"}
- SEO: ${seoIssues.join(", ") || "none"}
- Accessibility: ${accessIssues.join(", ") || "none"}
- Top improvements: ${improvements.join(", ") || "none"}

Return ONLY a valid JSON object with NO markdown, NO code fences, NO extra text:
{
  "subject": "short email subject line",
  "opening": "2-3 sentence friendly opening paragraph referencing their specific site issues. No generic openers.",
  "issue1": { "title": "short issue title", "detail": "one sentence explaining impact" },
  "issue2": { "title": "short issue title", "detail": "one sentence explaining impact" },
  "issue3": { "title": "short issue title", "detail": "one sentence explaining impact" },
  "closing": "1-2 sentence soft close. Mention Refactrix naturally. Invite a 15-min call — no pressure."
}

Rules: casual and human, not salesy. Use \\n if needed inside strings — no literal newlines.`;

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-20b",
    max_tokens: 1024,
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.choices[0]?.message?.content || null;
  const content = extractJSON(text);

  if (!content?.subject || !content?.opening || !content?.issue1) {
    throw new Error(`Malformed Groq response: ${text?.slice(0, 300)}`);
  }

  return content;
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function runEmailGen() {
  console.log("Starting email generation...\n");

  const calendarLink =
    process.env.CALENDAR_LINK || "https://calendly.com/YOUR_LINK";

  // Reset stuck processing rows
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
      .or(
        "email_status.eq.pending,email_status.is.null,email_status.eq.processing",
      )
      .not("email", "is", null)
      .gte("opportunity_score", 6)
      .limit(10);

    if (error) {
      console.error("Supabase error:", error.message);
      break;
    }

    if (!leads || leads.length === 0) {
      console.log("No more eligible leads.");
      break;
    }

    for (const lead of leads) {
      console.log(`\nProcessing: ${lead.business_name} → ${lead.email}`);

      await supabase
        .from("leads")
        .update({ email_status: "processing" })
        .eq("id", lead.id);

      try {
        const content = await generateEmailContent(lead);

        const domain =
          lead.domain ||
          lead.website?.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];

        const html = buildHtml({
          businessName: lead.business_name,
          domain,
          opening: content.opening,
          issue1: content.issue1,
          issue2: content.issue2,
          issue3: content.issue3,
          closing: content.closing,
          calendarLink,
        });

        // Save to Supabase
        const { error: updateError } = await supabase
          .from("leads")
          .update({
            email_subject: content.subject,
            email_body: html,
            email_status: "ready",
          })
          .eq("id", lead.id);

        if (updateError)
          throw new Error(`DB update failed: ${updateError.message}`);

        console.log(`  ✓ Ready: "${content.subject}"`);
        totalGenerated++;
      } catch (err) {
        await supabase
          .from("leads")
          .update({ email_status: "pending" })
          .eq("id", lead.id);

        console.error(`  ✗ Failed: ${err.message}`);
        totalFailed++;
      }

      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Ready:  ${totalGenerated}`);
  console.log(`  Failed: ${totalFailed}`);
  console.log(
    `\nReview leads in Supabase, set email_status = 'approved', then run: node sendapproved.js`,
  );
}

runEmailGen();
