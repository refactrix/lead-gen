import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import imapSimple from "imap-simple";
import dotenv from "dotenv";
dotenv.config();

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

function buildPlainText(lead) {
  return lead.email_body
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, "\n")
    .trim();
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

  await new Promise((resolve, reject) => {
    connection.imap.append(
      rawMessage,
      { mailbox: "INBOX.Sent", flags: ["\\Seen"] },
      (err) => { if (err) reject(err); else resolve(); }
    );
  });

  connection.end();
}

async function sendApproved() {
  console.log("Fetching approved leads...\n");

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, business_name, email, email_subject, email_body")
    .eq("email_status", "approved")
    .limit(20);

  if (error) {
    console.error("Supabase error:", error.message);
    return;
  }

  if (!leads?.length) {
    console.log("No approved leads to send.");
    console.log("Mark leads as 'approved' in Supabase to send them.");
    return;
  }

  console.log(`Found ${leads.length} approved leads to send.\n`);

  let sent = 0;
  let failed = 0;

  for (const lead of leads) {
    try {
      const unsubscribeEmail = `mailto:${process.env.HOSTINGER_EMAIL}?subject=Unsubscribe`;
      const unsubscribeWeb = `https://refactrix.com/unsubscribe?email=${encodeURIComponent(lead.email)}`;

      // Send via SMTP and capture raw message for Sent folder copy
      const streamTransporter = nodemailer.createTransport({ streamTransport: true, newline: "unix" });
      const info = await streamTransporter.sendMail({
        from: `"Mohit Jeswani @ Refactrix" <${process.env.HOSTINGER_EMAIL}>`,
        to: lead.email,
        subject: lead.email_subject,
        html: lead.email_body,
        text: buildPlainText(lead),
        headers: {
          "List-Unsubscribe": `<${unsubscribeWeb}>, <${unsubscribeEmail}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      const chunks = [];
      for await (const chunk of info.message) chunks.push(chunk);
      const rawMessage = Buffer.concat(chunks);

      // Send via SMTP
      await transporter.sendMail({
        from: `"Mohit Jeswani @ Refactrix" <${process.env.HOSTINGER_EMAIL}>`,
        to: lead.email,
        subject: lead.email_subject,
        html: lead.email_body,
        text: buildPlainText(lead),
        headers: {
          "List-Unsubscribe": `<${unsubscribeWeb}>, <${unsubscribeEmail}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });

      // Copy to Hostinger Sent folder
      await copyToSent(rawMessage);

      await supabase
        .from("leads")
        .update({
          email_status: "sent",
          contacted_at: new Date().toISOString(),
        })
        .eq("id", lead.id);

      console.log(`✓ Sent: ${lead.business_name} → ${lead.email}`);
      sent++;

      // 3s delay between sends to avoid triggering spam filters
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      console.error(`✗ Failed: ${lead.business_name} → ${err.message}`);

      await supabase
        .from("leads")
        .update({ email_status: "ready" })
        .eq("id", lead.id);

      failed++;
    }
  }

  console.log(`\nDone.`);
  console.log(`  Sent:   ${sent}`);
  console.log(`  Failed: ${failed}`);
}

sendApproved();
