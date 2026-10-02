import { createClient } from "@supabase/supabase-js";
import readline from "readline";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

function printTable(leads) {
  console.log("");
  console.log(
    "#".padEnd(4) +
    "Business".padEnd(35) +
    "Email".padEnd(40) +
    "Score".padEnd(7) +
    "Status"
  );
  console.log("─".repeat(100));
  leads.forEach((lead, i) => {
    const email = lead.email || "(none)";
    const name = lead.business_name?.slice(0, 33).padEnd(35) || "".padEnd(35);
    const emailCol = email.slice(0, 38).padEnd(40);
    const score = String(lead.opportunity_score ?? "–").padEnd(7);
    const status = lead.email_status || "–";
    console.log(`${String(i + 1).padEnd(4)}${name}${emailCol}${score}${status}`);
  });
  console.log("");
}

async function listLeads(filter = "all") {
  let query = supabase
    .from("leads")
    .select("id, business_name, website, email, opportunity_score, email_status, audit_status")
    .eq("audit_status", "done")
    .order("opportunity_score", { ascending: false })
    .limit(100);

  if (filter === "missing") query = query.is("email", null);
  if (filter === "has") query = query.not("email", "is", null);

  const { data, error } = await query;
  if (error) { console.error("Error:", error.message); return []; }
  return data || [];
}

async function setEmail(leads) {
  const input = await ask("Enter lead number: ");
  const idx = parseInt(input) - 1;
  if (isNaN(idx) || idx < 0 || idx >= leads.length) {
    console.log("Invalid selection.");
    return;
  }

  const lead = leads[idx];
  console.log(`\nLead: ${lead.business_name}`);
  console.log(`Current email: ${lead.email || "(none)"}`);

  const newEmail = (await ask("New email address (leave blank to cancel): ")).trim();
  if (!newEmail) { console.log("Cancelled."); return; }

  const { error } = await supabase
    .from("leads")
    .update({ email: newEmail })
    .eq("id", lead.id);

  if (error) console.error("Failed:", error.message);
  else console.log(`✓ Email updated to: ${newEmail}`);
}

async function removeEmail(leads) {
  const input = await ask("Enter lead number to remove email: ");
  const idx = parseInt(input) - 1;
  if (isNaN(idx) || idx < 0 || idx >= leads.length) {
    console.log("Invalid selection.");
    return;
  }

  const lead = leads[idx];
  if (!lead.email) { console.log("No email set on this lead."); return; }

  console.log(`\nLead: ${lead.business_name}`);
  console.log(`Email to remove: ${lead.email}`);
  const confirm = (await ask("Confirm remove? (y/n): ")).trim().toLowerCase();
  if (confirm !== "y") { console.log("Cancelled."); return; }

  const { error } = await supabase
    .from("leads")
    .update({ email: null })
    .eq("id", lead.id);

  if (error) console.error("Failed:", error.message);
  else console.log("✓ Email removed.");
}

async function main() {
  console.log("\n╔══════════════════════════════╗");
  console.log("║   Refactrix · Email Manager  ║");
  console.log("╚══════════════════════════════╝\n");

  let running = true;
  let currentLeads = [];

  while (running) {
    console.log("Options:");
    console.log("  1  View all audited leads");
    console.log("  2  View leads with email");
    console.log("  3  View leads missing email");
    console.log("  4  Add / update an email");
    console.log("  5  Remove an email");
    console.log("  6  Exit");
    console.log("");

    const choice = (await ask("Choose: ")).trim();

    switch (choice) {
      case "1":
        currentLeads = await listLeads("all");
        printTable(currentLeads);
        break;

      case "2":
        currentLeads = await listLeads("has");
        printTable(currentLeads);
        break;

      case "3":
        currentLeads = await listLeads("missing");
        printTable(currentLeads);
        break;

      case "4":
        if (currentLeads.length === 0) {
          console.log("Load leads first (option 1, 2, or 3).\n");
        } else {
          await setEmail(currentLeads);
          currentLeads = await listLeads("all");
          printTable(currentLeads);
        }
        break;

      case "5":
        if (currentLeads.length === 0) {
          console.log("Load leads first (option 1, 2, or 3).\n");
        } else {
          await removeEmail(currentLeads);
          currentLeads = await listLeads("all");
          printTable(currentLeads);
        }
        break;

      case "6":
        running = false;
        break;

      default:
        console.log("Invalid option.\n");
    }
  }

  rl.close();
  console.log("Bye.");
}

main();
