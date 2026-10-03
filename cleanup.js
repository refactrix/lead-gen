import "./redact-logs.js";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// Retention (see refactrix.com/privacy): a lead is deleted 12 months after
// we last emailed it, or 12 months after it was collected if it was never
// emailed. Kept: leads marked "interested" (a live conversation) and leads
// queued for sending. The suppression list is a separate table and is never
// touched, so an address that unsubscribed stays blocked after its lead goes.
//
// DRY_RUN=1 reports what would be deleted without deleting anything.

const RETENTION_MONTHS = 12;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const PAGE = 500;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function cutoffDate() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - RETENTION_MONTHS);
  return d;
}

async function findStaleLeads(cutoff) {
  const iso = cutoff.toISOString();
  const stale = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, status, email_status, contacted_at, created_at")
      .or(`contacted_at.lt."${iso}",and(contacted_at.is.null,created_at.lt."${iso}")`)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Lookup failed: ${error.message}`);
    stale.push(
      ...data.filter(
        (l) => l.status !== "interested" && !["approved", "sending"].includes(l.email_status),
      ),
    );
    if (data.length < PAGE) break;
  }
  return stale;
}

async function main() {
  const cutoff = cutoffDate();
  console.log(`Retention: ${RETENTION_MONTHS} months — removing leads last active before ${cutoff.toISOString().slice(0, 10)}`);
  if (DRY_RUN) console.log("DRY RUN — nothing will be deleted.\n");

  const stale = await findStaleLeads(cutoff);
  const byStatus = stale.reduce((acc, l) => ((acc[l.email_status ?? "none"] = (acc[l.email_status ?? "none"] ?? 0) + 1), acc), {});
  console.log(`Leads past retention: ${stale.length}`);
  for (const [status, n] of Object.entries(byStatus)) console.log(`  ${status}: ${n}`);

  if (DRY_RUN || stale.length === 0) return;

  let deleted = 0;
  for (let i = 0; i < stale.length; i += 100) {
    const ids = stale.slice(i, i + 100).map((l) => l.id);
    const { error, count } = await supabase.from("leads").delete({ count: "exact" }).in("id", ids);
    if (error) throw new Error(`Delete failed after ${deleted} rows: ${error.message}`);
    deleted += count ?? ids.length;
  }
  console.log(`\nDeleted ${deleted} lead${deleted === 1 ? "" : "s"}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
