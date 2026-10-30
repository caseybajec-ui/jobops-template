import { all, run } from "@/lib/driver";
import { COMPANY_NAMES } from "@/lib/config.generated";
import { today as todayIn } from "@/lib/day";
import { extractApplications } from "@/lib/ask";
import { importApplyLog } from "@/lib/importlog";

/**
 * POST /api/applications — an apply log the owner pasted in by hand.
 *
 * The parsing, the row cap, the zero-row red banner and the upsert all live
 * in lib/importlog.js, shared with the token route at /api/applications/import
 * so the two doors cannot drift. This route adds only what the paste box
 * needs: a session (middleware) and "today" in the owner's timezone.
 *
 * NOTHING HERE CONTACTS THE BOT THAT WROTE THE LOG. No client, no webhook, no
 * polling, no credential, no outbound request of any kind.
 */
export const dynamic = "force-dynamic";

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const { status, body: out } = await importApplyLog({
    text: body.text, today: todayIn(), source: "grok_paste",
    extract: extractApplications,
  });
  return Response.json(out, { status });
}

/**
 * PATCH /api/applications — resolve an unmatched employer to a company.
 *
 * BY HAND, ALWAYS. matchEmployer() refuses anything fuzzier than an exact or
 * clean-suffix match, so the unmatched list is where a wrong-looking employer
 * surfaces and this is how it gets resolved. Nothing infers it: a wrong merge
 * files an application against the wrong company and is invisible afterwards,
 * because the row looks exactly like a right one.
 */
export async function PATCH(req) {
  const { employer_raw: raw, employer_id: slug } = await req.json().catch(() => ({}));
  if (!raw) return Response.json({ error: "no employer" }, { status: 400 });

  // A slug the owner did not choose from the list is a typo, not a new company.
  if (slug && !COMPANY_NAMES.some((c) => c.slug === slug)) {
    return Response.json(
      { error: `${slug} is not a company in companies.yaml` }, { status: 400 });
  }

  const r = await run(
    "UPDATE applied_apps SET employer_id = ? WHERE lower(employer_raw) = lower(?)",
    [slug || null, raw]);
  return Response.json({ ok: true, changed: r?.changes ?? null });
}

/** Everything the page renders. */
export async function GET() {
  const rows = await all(
    "SELECT id, applied_date, channel, employer_raw, employer_id, role, "
    + " location, status, notes, source FROM applied_apps "
    // Ends in a unique column: a comparator that can return 0 for two distinct
    // rows reshuffles the page on every load, which has happened three times
    // in this project.
    + "ORDER BY applied_date DESC, employer_raw, id LIMIT 500").catch(() => null);
  return Response.json({
    rows,
    unmatched: rows
      ? [...new Set(rows.filter((r) => !r.employer_id)
          .map((r) => r.employer_raw))].sort()
      : [],
    known: COMPANY_NAMES,
  });
}
