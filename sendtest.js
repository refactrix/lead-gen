import nodemailer from "nodemailer";
import { readFileSync } from "fs";
import imapSimple from "imap-simple";
import dotenv from "dotenv";
dotenv.config();

const html = readFileSync("./sample-email.html", "utf8");

const FROM = process.env.HOSTINGER_EMAIL;
const TO = process.env.TEST_EMAIL;
const SUBJECT = "Website audit — a few quick wins for your site";

const plainText = [
  `Hi Bristol Plumber365,`,
  ``,
  `I looked at your site recently — you're doing a lot right, but there are a few things quietly costing you new enquiries. Thought it was worth flagging.`,
  ``,
  `What we found on bristolplumber365.co.uk:`,
  `- Slow page load on mobile: Unoptimised images add 3–4 seconds to load — most visitors leave after 3s.`,
  `- Missing SEO meta tags: No meta description means Google has nothing to show — you're invisible in search snippets.`,
  `- Contact form breaks on small screens: The form overflows on phones — your most common visitor device.`,
  ``,
  `I run Refactrix, a software engineering studio that helps UK businesses fix exactly these kinds of gaps. These are straightforward wins — happy to run you through what's involved in 20 minutes if it's useful.`,
  ``,
  `Best,`,
  `Mohit Jeswani`,
  `Founder, Refactrix`,
  `refactrix.com`,
].join("\n");

const unsubscribeEmail = `mailto:${FROM}?subject=Unsubscribe`;
const unsubscribeWeb = `https://refactrix.com/unsubscribe?email=${encodeURIComponent(TO)}`;

// Connect to IMAP once — used for both Drafts copy (optional) and Sent copy
console.log("Connecting to IMAP...");
const imapConn = await imapSimple.connect({
  imap: {
    user: FROM,
    password: process.env.HOSTINGER_PASSWORD,
    host: "imap.hostinger.com",
    port: 993,
    tls: true,
    authTimeout: 15000,
  },
});
console.log("Connected.\n");

// Build raw message for Sent folder copy
const streamTransporter = nodemailer.createTransport({ streamTransport: true, newline: "unix" });
const streamInfo = await streamTransporter.sendMail({
  from: `"Mohit Jeswani @ Refactrix" <${FROM}>`,
  to: TO,
  subject: SUBJECT,
  html,
  text: plainText,
  headers: {
    "List-Unsubscribe": `<${unsubscribeWeb}>, <${unsubscribeEmail}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
});
const chunks = [];
for await (const chunk of streamInfo.message) chunks.push(chunk);
const rawMessage = Buffer.concat(chunks);

// Send via SMTP
console.log(`Sending to ${TO}...`);
const smtpTransporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 465,
  secure: true,
  auth: {
    user: FROM,
    pass: process.env.HOSTINGER_PASSWORD,
  },
});

await smtpTransporter.sendMail({
  from: `"Mohit Jeswani @ Refactrix" <${FROM}>`,
  to: TO,
  subject: SUBJECT,
  html,
  text: plainText,
  headers: {
    "List-Unsubscribe": `<${unsubscribeWeb}>, <${unsubscribeEmail}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
});
console.log("Sent.");

// Copy to Hostinger Sent folder
console.log("Copying to Sent folder...");
await new Promise((resolve, reject) => {
  imapConn.imap.append(rawMessage, { mailbox: "INBOX.Sent", flags: ["\\Seen"] }, (err) => {
    if (err) reject(err);
    else resolve();
  });
});
console.log("Copied to Sent.");

imapConn.end();
console.log(`\nDone. Check your inbox at ${TO} and Sent folder at mail.hostinger.com.`);
