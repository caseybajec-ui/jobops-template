import { all, one, run } from "@/lib/driver";
import { parsePastedPeople, rankContact, normName, normCompany } from "@/lib/sourcing";

/**
 * POST /api/paste — text the owner pasted from a search he ran himself.
 *
 * THE FALLBACK, AND THE ONLY PATH WHEN THE READER IS OFF. It carries no risk
 * at all: he ran the search, he copied the text, this parses it. No fetch, no
 * login, no automation of any kind.
 *
 * NOTHING BECOMES A CONTACT HERE. Rows land in suggested_contacts and he taps
 * promote, exactly as the reader's do.
 */
export const dynamic = "force-dynamic";

const id = () => `s:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function POST(req) {
  const { text, company, company_slug } = await req.json().catch(() => ({}));
  if (!text || !String(text).trim()) {
    return Response.json({ error: "nothing pasted" }, { status: 400 });
  }

  const people = parsePastedPeople(text, company);
  if (!people.length) {
    // PARSED NOTHING IS AN ANSWER, not a success. A paste that yields no
    // people means the page shape changed or the wrong thing was copied, and
    // reporting "0 added" as if it were a quiet result hides both.
    return Response.json({
      stored: 0, duplicates: 0,
      note: "Nothing looked like a person in that text. Copy the search "
        + "results themselves rather than the page chrome.",
    });
  }

  const sizes = Object.fromEntries((await all(
    "SELECT company, count(*) AS n FROM jobs WHERE closed_at IS NULL "
    + "GROUP BY company").catch(() => [])).map((r) => [r.company, Number(r.n)]));

  let stored = 0;
  let dupes = 0;
  for (const p of people) {
    const dup = await one(
      "SELECT id FROM suggested_contacts WHERE lower(name) = lower(?) "
      + "AND lower(COALESCE(company,'')) = lower(?)",
      [p.name, p.company || company || ""]);
    const known = await one(
      "SELECT id FROM contacts WHERE lower(name) = lower(?)", [p.name])
      .catch(() => null);
    if (dup || known) { dupes++; continue; }

    const { rank, why } = rankContact({
      ...p, companyRoles: sizes[company_slug],
    });
    await run(
      "INSERT INTO suggested_contacts (id, name, company, company_slug, title, "
      + " school, source, rank, rank_reason, raw, created_at) "
      + "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [id(), p.name, p.company || company || null, company_slug || null,
       p.title || null, p.school || null, "manual_paste", rank, why,
       String(p.raw || "").slice(0, 1200), new Date().toISOString()]);
    stored++;
  }
  return Response.json({ stored, duplicates: dupes, parsed: people.length });
}
