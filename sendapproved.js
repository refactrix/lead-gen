import "./redact-logs.js";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import imapSimple from "imap-simple";
import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config();

// ─── Startup checks ──────────────────────────────────────────────────────────
// Fail closed: never send without a working opt-out link and suppression check.

if (!process.env.UNSUBSCRIBE_SECRET) {
  console.error("UNSUBSCRIBE_SECRET is not set — refusing to send without a valid unsubscribe link.");
  process.exit(1);
}

// The suppressions table has RLS on with no policies. An anon/publishable key
// reads it as empty without an error, so the suppression check would silently
// pass. Detect those keys and stop.
function isPublicKey(key = "") {
  if (key.startsWith("sb_publishable_")) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.role === "anon";
  } catch {
    return false;
  }
}

if (isPublicKey(process.env.SUPABASE_KEY)) {
  console.error("SUPABASE_KEY is an anon/publishable key — the suppression list is not readable with it.");
  console.error("Use the project's secret (service role) key for this script.");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.HOSTINGER_EMAIL,
    pass: process.env.HOSTINGER_PASSWORD,
  },
});

// ─── Unsubscribe link ────────────────────────────────────────────────────────
// Must match the signing in refactrix/web app/unsubscribe/route.ts.

function unsubscribeUrl(email) {
  const e = email.trim().toLowerCase();
  const t = crypto.createHmac("sha256", process.env.UNSUBSCRIBE_SECRET).update(e).digest("hex");
  return `https://refactrix.com/unsubscribe?e=${encodeURIComponent(e)}&t=${t}`;
}

// New drafts carry a {{UNSUBSCRIBE_URL}} placeholder. Older drafts have a
// mailto link in the footer, which is swapped for the web link.
function withUnsubscribeLink(html, url) {
  const href = url.replace(/&/g, "&amp;");
  if (html.includes("{{UNSUBSCRIBE_URL}}")) {
    return html.replaceAll("{{UNSUBSCRIBE_URL}}", href);
  }
  const legacy = /href="mailto:[^"]*\?subject=Unsubscribe"/;
  if (legacy.test(html)) {
    return html.replace(legacy, `href="${href}"`);
  }
  const footer = `<p style="font-size:11px;color:#a1a1aa;text-align:center;"><a href="${href}" style="color:#a1a1aa;">Unsubscribe</a></p>`;
  return html.includes("</body>") ? html.replace("</body>", `${footer}</body>`) : html + footer;
}

function buildPlainText(html, url) {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, "\n")
    .trim();
  return `${text}\n\nUnsubscribe: ${url}`;
}

async function copyToSent(rawMessage) {
  const connection = await imapSimple.connect({
    imap: {
      user: process.env.HOSTINGER_EMAIL,
      password: process.env.HOSTINGER_PASSWORD,
      host: "imap.hostinger.com",
      port: 993,
      tls: true,
      authTimeout: 15000,
    },
  });

  try {
    await new Promise((resolve, reject) => {
      connection.imap.append(
        rawMessage,
        { mailbox: "INBOX.Sent", flags: ["\\Seen"] },
        (err) => { if (err) reject(err); else resolve(); }
      );
    });
  } finally {
    connection.end();
  }
}

async function setStatus(id, email_status, extra = {}) {
  const { error } = await supabase
    .from("leads")
    .update({ email_status, ...extra })
    .eq("id", id);
  return error;
}

// ─── Main ────────────────────────────────────────────────────────────────────

// Max emails per run. The Actions workflow sets this lower so a scheduled
// run spreads sends across the day; hard ceiling of 50.
const BATCH_LIMIT = Math.min(
  Math.max(parseInt(process.env.SEND_BATCH_LIMIT ?? "20", 10) || 20, 1),
  50,
);

async function sendApproved() {
  console.log(`Fetching approved leads (up to ${BATCH_LIMIT})...\n`);

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, business_name, email, email_subject, email_body")
    .eq("email_status", "approved")
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("Supabase error:", error.message);
    process.exitCode = 1;
    return;
  }

  if (!leads?.length) {
    console.log("No approved leads to send.");
    console.log("Mark leads as 'approved' in the admin to send them.");
    return;
  }

  // Load suppressions for this batch in one query. Any error stops the run.
  const addresses = [...new Set(leads.filter((l) => l.email).map((l) => l.email.trim().toLowerCase()))];
  const { data: suppressedRows, error: supError } = await supabase
    .from("suppressions")
    .select("email")
    .in("email", addresses);

  if (supError) {
    console.error("Could not read suppression list — not sending anything:", supError.message);
    process.exitCode = 1;
    return;
  }
  const suppressed = new Set(suppressedRows.map((r) => r.email));

  console.log(`Found ${leads.length} approved leads to send.\n`);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const lead of leads) {
    if (!lead.email || !lead.email_body || !lead.email_subject) {
      console.log(`– Skipped (missing email, subject or body): ${lead.business_name}`);
      skipped++;
      continue;
    }

    if (suppressed.has(lead.email.trim().toLowerCase())) {
      await setStatus(lead.id, "opted_out");
      console.log(`– Skipped (suppressed): ${lead.business_name} → ${lead.email}`);
      skipped++;
      continue;
    }

    // Claim the row: only flips approved → sending, so an overlapping run
    // cannot send the same lead. From here the row is never reset to ready.
    const { data: claimed, error: claimError } = await supabase
      .from("leads")
      .update({ email_status: "sending" })
      .eq("id", lead.id)
      .eq("email_status", "approved")
      .select("id");

    if (claimError || !claimed?.length) {
      console.log(`– Skipped (could not claim): ${lead.business_name}${claimError ? ` → ${claimError.message}` : ""}`);
      skipped++;
      continue;
    }

    const url = unsubscribeUrl(lead.email);
    const html = withUnsubscribeLink(lead.email_body, url);
    const mail = {
      from: `"Mohit Jeswani @ Refactrix" <${process.env.HOSTINGER_EMAIL}>`,
      to: lead.email,
      subject: lead.email_subject,
      html,
      text: buildPlainText(html, url),
      headers: {
        "List-Unsubscribe": `<${url}>, <mailto:${process.env.HOSTINGER_EMAIL}?subject=Unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };

    let accepted = false;

    try {
      // Build the raw message for the Sent folder copy before sending
      const streamTransporter = nodemailer.createTransport({ streamTransport: true, newline: "unix" });
      const info = await streamTransporter.sendMail(mail);
      const chunks = [];
      for await (const chunk of info.message) chunks.push(chunk);
      const rawMessage = Buffer.concat(chunks);

      await transporter.sendMail(mail);
      accepted = true;

      const updateError = await setStatus(lead.id, "sent", {
        contacted_at: new Date().toISOString(),
      });
      if (updateError) {
        console.error(`! Sent but DB update failed — left in 'sending', mark as sent by hand: ${lead.business_name} → ${updateError.message}`);
        process.exitCode = 1;
      }

      try {
        await copyToSent(rawMessage);
      } catch (err) {
        console.warn(`  Sent folder copy failed (email was sent): ${err.message}`);
      }

      console.log(`✓ Sent: ${lead.business_name} → ${lead.email}`);
      sent++;
    } catch (err) {
      if (!accepted) {
        // An SMTP timeout can still mean the message was delivered, so a
        // failed row is checked against the Sent folder before re-approving.
        await setStatus(lead.id, "failed");
      }
      console.error(`✗ Failed: ${lead.business_name} → ${err.message}`);
      failed++;
    }

    // 3s delay between sends to avoid triggering spam filters
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(`\nDone.`);
  console.log(`  Sent:    ${sent}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);

  // A failed send needs a person to check the Sent folder, so fail the run
  // and let GitHub's failure email flag it.
  if (failed > 0) process.exitCode = 1;
}

sendApproved();
