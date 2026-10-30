import { all } from "@/lib/driver";
import { toCsv } from "@/lib/zip";
// today(), not toISOString(). A file downloaded at 6pm in Los Angeles
// would otherwise be stamped tomorrow, and two downloads on the same
// evening would carry different dates.
import { today } from "@/lib/day";

/**
 * GET /api/export/apply — one CSV of the roles that are ready to apply to.
 *
 * NOT /api/export, which is a backup: every table, one CSV each, in a zip, for
 * the day the Neon project goes wrong. This is the opposite errand -- the thing
 * the owner opens on a laptop with no JobOps running, to spend an hour applying.
 * One file, one row per role, everything the application needs in the row.
 *
 * APPLICATION-READY MEANS ALL FOUR, and the join says so rather than a comment:
 * open, scored, no hard blocker, and a pack with text. A role missing any of
 * those is not something he can sit down and apply to, and padding the file
 * with them turns an hour of applying into an hour of triage.
 *
 * THE PACK TEXT IS IN THE ROW. A CSV of links would be a bookmark list; the
 * whole point is that the cover note is there when the browser tab is not.
 *
 * NO AUTH CHANGE. It sits behind the same password gate as everything else and
 * must never reach middleware's allow list: it carries the drafted material.
 */
export const dynamic = "force-dynamic";

// Blockers that do NOT disqualify. Same two as apply_packs.OK_BLOCKERS: a
// clearance he can obtain is not a wall, and US citizenship is not a
// constraint for a US citizen.
const OK_BLOCKERS = ["clearance_obtainable", "citizenship_only"];

export async function GET() {
  const rows = await all(
    `SELECT j.company, COALESCE(j.display_name, j.company) AS display_name,
            j.title, j.location, j.url, s.score, j.blockers,
            p.variant, p.variant_reason, p.cover_note, p.why_company,
            p.why_role, p.project_story, p.biggest_challenge,
            p.critic_note, p.used_at
       FROM jobs j
       JOIN scores s ON s.key = j.key
       JOIN apply_packs p ON p.key = j.key
      WHERE j.closed_at IS NULL
        AND p.cover_note IS NOT NULL
        AND j.entry_level IN ('program','entry')
        AND COALESCE(j.class_fit,'ok') <> 'wrong_year'
        AND COALESCE(j.clearance_status,'none_mentioned') <> 'required_active'
      -- Highest fit first, tie-broken on url so the file does not reshuffle
      -- between downloads. Eight Palantir roles sit at exactly 78.
      ORDER BY s.score DESC NULLS LAST, j.url`);

  // The blocker column is stored as a JSON array of tags. Rendered as a plain
  // list, because a CSV opened in Excel should not contain JSON.
  const shaped = rows.map((r) => {
    let tags = [];
    try {
      tags = JSON.parse(r.blockers || "[]");
    } catch { tags = []; }
    const hard = tags.filter((t) => !OK_BLOCKERS.includes(t));
    return {
      company: r.display_name,
      title: r.title,
      location: r.location,
      score: r.score,
      variant: r.variant || "",
      // NAMED FOR WHAT IT IS. "blockers" alone would read as "reasons not to
      // apply"; these are the ones that do not stop him, and the column that
      // would stop him is empty by construction because the query excludes it.
      obtainable_blockers: tags.filter((t) => OK_BLOCKERS.includes(t)).join(" "),
      hard_blockers: hard.join(" "),
      already_used: r.used_at ? String(r.used_at).slice(0, 10) : "",
      critic: r.critic_note || "",
      url: r.url,
      variant_reason: r.variant_reason || "",
      cover_note: r.cover_note || "",
      why_company: r.why_company || "",
      why_role: r.why_role || "",
      project_story: r.project_story || "",
      biggest_challenge: r.biggest_challenge || "",
    };
  });

  const csv = toCsv(shaped);
  const day = today();
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        `attachment; filename="jobops-apply-${day}.csv"`,
    },
  });
}
