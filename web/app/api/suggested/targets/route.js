import { all } from "@/lib/driver";
import { schoolPeopleSearchUrl } from "@/lib/constants";

/**
 * GET /api/suggested/targets?limit=3 — which companies to search today.
 *
 * FEWEST CONTACTS FIRST, among companies with a reachable 60+ role. The point
 * of the whole networking half is that a referral routes around the two things
 * that stop this profile, and a company where the owner already knows two
 * people does not need a third before one where they know nobody.
 *
 * IT HANDS BACK THE SEARCH URL RATHER THAN A QUERY. schoolPeopleSearchUrl is
 * the pattern the owner verified by clicking -- school /people/ pages silently
 * ignore ?keywords= -- and the reader must not build its own. One definition.
 */
export const dynamic = "force-dynamic";

const TOKEN = process.env.JOBOPS_LOCAL_TOKEN;

function tokenOk(header) {
  const given = String(header || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || !given || given.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) {
    diff |= TOKEN.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(req) {
  if (!tokenOk(req.headers.get("authorization"))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(req.url);
  // CAPPED SERVER-SIDE TOO. The reader enforces its own limit, and a cap that
  // exists in only one place is one deploy away from not existing.
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 3, 1), 5);

  const rows = await all(
    `SELECT j.company AS name,
            COALESCE(j.display_name, j.company) AS display_name,
            max(s.score) AS best,
            (SELECT count(*) FROM contacts c WHERE c.company = j.company) AS contacts
       FROM jobs j JOIN scores s ON s.key = j.key
      WHERE j.closed_at IS NULL AND s.score >= 60
        AND j.entry_level IN ('program','entry')
        AND COALESCE(j.class_fit,'ok') <> 'wrong_year'
        AND COALESCE(j.clearance_status,'none_mentioned') <> 'required_active'
      GROUP BY j.company, display_name
     HAVING (SELECT count(*) FROM contacts c WHERE c.company = j.company) < 2
      -- Fewest contacts, then best fit, then name so the order is total and
      -- the same five do not reshuffle between runs.
      ORDER BY contacts ASC, best DESC, j.company
      LIMIT ?`, [limit]);

  return Response.json({
    companies: rows.map((r) => ({
      name: r.name,
      display_name: r.display_name,
      contacts: Number(r.contacts),
      search_url: schoolPeopleSearchUrl(r.display_name),
    })),
  });
}
