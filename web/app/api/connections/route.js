import { all, one, run } from "@/lib/driver";
import { parseConnections, rankContact, companyMatches } from "@/lib/sourcing";

/**
 * POST /api/connections — the owner's LinkedIn connections export.
 *
 * A FILE HE DOWNLOADED. No automation, no risk, and the highest-signal source
 * there is: these are people who already accepted him.
 *
 * ONLY ROWS AT TARGET COMPANIES. The export runs to thousands; staging all of
 * them would bury the handful that matter under everyone he met at a
 * conference. Matched with companyMatches, which is whole-token -- a bare
 * substring files a Metabase engineer under Meta.
 */
export const dynamic = "force-dynamic";

const id = () => `s:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function POST(req) {
  const { csv } = await req.json().catch(() => ({}));
  const { rows, error } = parseConnections(csv);
  if (error) return Response.json({ error }, { status: 400 });
  if (!rows.length) {
    return Response.json({ stored: 0, note: "the file parsed but held no rows" });
  }

  const targets = await all(
    `SELECT j.company AS slug, COALESCE(j.display_name, j.company) AS name,
            count(*) AS n
       FROM jobs j JOIN scores s ON s.key = j.key
      WHERE j.closed_at IS NULL AND s.score >= 60
      GROUP BY j.company, name`);

  let stored = 0;
  let dupes = 0;
  let offTarget = 0;
  for (const r of rows) {
    const t = targets.find((x) => companyMatches(r.company, x.name)
                               || companyMatches(r.company, x.slug));
    if (!t) { offTarget++; continue; }

    const dup = await one(
      "SELECT id FROM suggested_contacts WHERE lower(name) = lower(?) "
      + "AND lower(COALESCE(company,'')) = lower(?)", [r.name, r.company]);
    const known = await one(
      "SELECT id FROM contacts WHERE lower(name) = lower(?)", [r.name])
      .catch(() => null);
    if (dup || known) { dupes++; continue; }

    const { rank, why } = rankContact({
      title: r.title, source: "linkedin_export", connected: true,
      companyRoles: Number(t.n),
    });
    await run(
      "INSERT INTO suggested_contacts (id, name, company, company_slug, title, "
      + " source, rank, rank_reason, raw, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [id(), r.name, t.name, t.slug, r.title || null, "linkedin_export",
       rank, why, `connected ${r.connected_on || "?"}`,
       new Date().toISOString()]);
    stored++;
  }
  // OFF-TARGET IS REPORTED, so "I imported 3,000 connections and got 4" reads
  // as working rather than broken.
  return Response.json({ stored, duplicates: dupes, offTarget, total: rows.length });
}
