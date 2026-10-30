import { all, one, run } from "@/lib/driver";
import { rankContact, normName, normCompany } from "@/lib/sourcing";

/**
 * POST /api/suggested — the local reader's only way in.
 * GET  /api/suggested/targets — which companies it should search.
 *
 * BEARER AUTH, SEPARATE FROM THE PASSWORD GATE. Every page in this app sits
 * behind middleware and a session cookie; this endpoint is called by a script
 * on the owner's PC that has no cookie and no browser. So it carries its own
 * token, and middleware lets it through on the strength of that token alone.
 *
 * THE TOKEN IS THE WHOLE PERIMETER, so it is compared in constant time and a
 * missing or wrong one is a flat 401 with no detail. An endpoint that says
 * "wrong token" rather than "unauthorized" tells an attacker the name is right.
 *
 * IT WRITES SUGGESTIONS AND NOTHING ELSE. There is no path here that creates a
 * contact, an outreach row, or a draft. That is what makes an automated reader
 * safe to point at it: the worst a compromised token can do is put names in a
 * staging table the owner has to tap through.
 */
export const dynamic = "force-dynamic";

const TOKEN = process.env.JOBOPS_LOCAL_TOKEN;

/** Constant-time compare, so the response time does not leak the prefix. */
function tokenOk(header) {
  const given = String(header || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || !given || given.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) {
    diff |= TOKEN.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

const deny = () => new Response(JSON.stringify({ error: "unauthorized" }),
  { status: 401, headers: { "content-type": "application/json" } });

const id = () => `s:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function POST(req) {
  if (!tokenOk(req.headers.get("authorization"))) return deny();

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }

  // A SKIP IS A ROW, not silence. "The machine was off", "idle for two hours"
  // and "halted on a checkpoint" are different nights, and a digest that can
  // only tell the good one from silence is the always-empty-source failure
  // with a browser attached.
  if (body.skipped) {
    await run(
      "INSERT INTO reader_runs (id, ran_at, searches, found, skipped, red) "
      + "VALUES (?,?,?,?,?,?)",
      [id(), new Date().toISOString(), 0, 0, String(body.skipped).slice(0, 400),
       body.red ? 1 : 0]);
    return Response.json({ ok: true, recorded: "skip" });
  }

  const people = Array.isArray(body.people) ? body.people : [];
  if (!people.length) {
    return Response.json({ ok: true, stored: 0, duplicates: 0 });
  }

  // Company size, for the founder rank. Read once rather than per person.
  const sizes = Object.fromEntries((await all(
    "SELECT company, count(*) AS n FROM jobs WHERE closed_at IS NULL "
    + "GROUP BY company").catch(() => [])).map((r) => [r.company, Number(r.n)]));

  let stored = 0;
  let dupes = 0;
  for (const p of people) {
    if (!p?.name) continue;
    const url = String(p.profile_url || "").trim();
    const existing = url
      ? await one("SELECT id FROM suggested_contacts WHERE profile_url = ?", [url])
      : await one(
        "SELECT id FROM suggested_contacts WHERE lower(name) = ? AND lower(COALESCE(company,'')) = ?",
        [normName(p.name), normCompany(p.company)]);
    if (existing) { dupes++; continue; }

    // ALREADY A REAL CONTACT? Then it is not a suggestion. The reader has no
    // idea who the owner already knows, and re-suggesting them every night is how
    // a queue stops being read.
    const known = await one(
      "SELECT id FROM contacts WHERE lower(name) = lower(?)", [p.name])
      .catch(() => null);
    if (known) { dupes++; continue; }

    const { rank, why } = rankContact({
      ...p, companyRoles: sizes[p.company_slug],
    });
    await run(
      "INSERT INTO suggested_contacts (id, name, company, company_slug, title, "
      + " headline, location, profile_url, school, source, source_url, rank, "
      + " rank_reason, raw, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id(), p.name, p.company || null, p.company_slug || null,
       p.title || null, p.headline || null, p.location || null, url || null,
       p.school || null, p.source || "unknown", p.source_url || null,
       rank, why, String(p.raw || "").slice(0, 1200),
       new Date().toISOString()]);
    stored++;
  }

  await run(
    "INSERT INTO reader_runs (id, ran_at, searches, found, skipped, red) "
    + "VALUES (?,?,?,?,?,?)",
    [id(), new Date().toISOString(), null, stored, null, 0]);

  return Response.json({ ok: true, stored, duplicates: dupes });
}
