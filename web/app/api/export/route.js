import { all } from "@/lib/driver";
import { zip, toCsv } from "@/lib/zip";

/**
 * GET /api/export — everything, as one CSV per table, in a zip.
 *
 * WHY IT EXISTS. Every fact this tool holds about the owner's search lives in one
 * Neon database behind one password, and there has never been a way to get it
 * out. That is a single point of failure for a year of work: an account
 * problem, a deleted project, a migration that goes wrong. A file on his laptop
 * is the answer, and it costs one route.
 *
 * NO AUTH CHANGES. The whole app is behind the password gate already, and this
 * route sits inside it — middleware.js matches everything not on the allow
 * list. It is worth being explicit that this endpoint returns EVERYTHING,
 * including contacts and the profile card, so it must never be added to that
 * allow list.
 */
export const dynamic = "force-dynamic";

/**
 * Every table, in the order a person would read them.
 *
 * `jobs` deliberately omits `description` — it is the largest column by a wide
 * margin, several kilobytes a row across ten thousand rows, and the export is
 * for the record of the SEARCH rather than a copy of the internet's job
 * postings. Everything else is complete.
 */
const TABLES = [
  ["jobs", "SELECT key, company, display_name, title, location, url, category, "
         + "start_window, yoe, posted_at, first_seen, closed_at, entry_level, "
         + "comp_min, comp_max, comp_source, class_fit, class_reason, start_year, "
         + "class_year, clearance_status, triage FROM jobs"],
  ["scores", "SELECT * FROM scores"],
  ["applications", "SELECT * FROM applications"],
  ["actions", "SELECT * FROM actions"],
  ["items", "SELECT * FROM items"],
  ["contacts", "SELECT * FROM contacts"],
  ["interactions", "SELECT * FROM interactions"],
  ["role_events", "SELECT * FROM role_events"],
  ["role_flags", "SELECT * FROM role_flags"],
  ["manual_applications", "SELECT * FROM manual_applications"],
  ["manual_application_events", "SELECT * FROM manual_application_events"],
  ["profile", "SELECT * FROM profile"],
  ["daily_availability", "SELECT * FROM daily_availability"],
  ["sf86_entries", "SELECT * FROM sf86_entries"],
  ["settings", "SELECT * FROM settings"],
  ["batches", "SELECT * FROM batches"],
];

export async function GET() {
  const files = [];
  const missing = [];

  for (const [name, sql] of TABLES) {
    try {
      files.push({ name: `${name}.csv`, data: toCsv(await all(sql)) });
    } catch {
      // A table that is not in this database yet is a fact worth exporting, not
      // a reason to fail the whole archive. It lands in README.txt below.
      missing.push(name);
    }
  }

  const day = new Date().toISOString().slice(0, 10);
  files.push({
    name: "README.txt",
    data: [
      `JobOps export — ${day}`,
      "",
      `${files.length} tables, one CSV each. Header row on every file, including`,
      "the empty ones — a CSV with no header cannot be told from a corrupt file.",
      "",
      "jobs.csv omits the `description` column deliberately: it is several",
      "kilobytes a row across ten thousand rows, and this is a record of the",
      "search rather than a copy of the internet's job postings.",
      "",
      missing.length
        ? `Not in this database yet, so not exported: ${missing.join(", ")}.`
        : "Every expected table was present.",
      "",
      "This archive contains other people's names and contact details, and your",
      "own address and phone number. It belongs on your own disk. It must never",
      "go in the repository — test_nothing_private_staged.py will refuse the",
      "commit, but the file should not get that far.",
    ].join("\n"),
  });

  const body = zip(files);
  return new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="jobops-export-${day}.zip"`,
      "content-length": String(body.length),
    },
  });
}
