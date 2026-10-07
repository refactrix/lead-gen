import "./redact-logs.js";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
import { findSiteEmails, hostOf } from "./sitecontacts.js";

// One-off: looks again for an email on the websites of leads saved without
// one (the old Google Maps scraper saved those too). Uses the same finder as
// leadfinder.js, so only an address on the business's own domain counts.
//
// Found: the lead gets its email and becomes eligible for a draft on the next
// "Process leads" run. Not found: the lead is left unchanged and listed.
//
//   node findemails.js           check and save
//   DRY_RUN=1 node findemails.js check only

const DRY_RUN = process.env.DRY_RUN === "1";
const CONCURRENCY = 4;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, business_name, website, domain")
    .is("email", null)
    .not("website", "is", null)
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Loading leads failed: ${error.message}`);

  console.log(`${leads.length} leads without an email${DRY_RUN ? " (dry run: nothing is saved)" : ""}\n`);

  const queue = [...leads];
  const notFound = [];
  let found = 0;

  async function worker() {
    while (queue.length) {
      const lead = queue.shift();
      const result = await findSiteEmails(lead.website, [], lead.business_name).catch(() => ({ emails: [], outcome: "unreachable" }));
      const { emails, outcome } = result;
      if (outcome !== "found") {
        notFound.push(`${lead.business_name} (${outcome.replace("_", " ")})`);
        continue;
      }
      const { data: suppressed, error: supError } = await supabase.from("suppressions").select("email").in("email", emails);
      if (supError) throw new Error(`Reading suppressions failed: ${supError.message}`);
      if (suppressed.length) {
        notFound.push(`${lead.business_name} (unsubscribed earlier)`);
        continue;
      }
      if (!DRY_RUN) {
        const { error: updateError } = await supabase
          .from("leads")
          // After a rebrand the email is on the new domain, so the website follows
          .update({ email: emails[0], emails, ...(result.website && { website: result.website, domain: hostOf(result.website) }) })
          .eq("id", lead.id)
          .is("email", null);
        if (updateError) throw new Error(`Saving ${lead.business_name} failed: ${updateError.message}`);
      }
      found++;
      console.log(`✓ ${lead.business_name} → ${emails[0]}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nFound an email for ${found} of ${leads.length}.`);
  if (notFound.length) {
    console.log(`\nStill without an email (${notFound.length}):`);
    for (const line of notFound.sort()) console.log(`  – ${line}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
