import { one } from "@/lib/driver";
import { resolved } from "@/lib/assert";

export const dynamic = "force-dynamic";

/**
 * Interview prep for one role.
 *
 * READ ONLY. Nothing on this page generates anything: the pack is built by
 * `python prep_pack.py build <key>` when a status actually reaches interview,
 * and a page that could spend money on render would be a second caller of the
 * API outside cron -- which CLAUDE.md allows exactly once, for the Ask box.
 *
 * A REFUSED PACK RENDERS ITS REASON, not its content. prep_pack stores the raw
 * with a note when a pack breaks a hard rule and leaves the structured columns
 * NULL. Showing the raw anyway would put the refused text in front of the owner an
 * hour before an interview, which is the one moment it must not appear.
 */
export default async function Page({ params }) {
  const { key } = await params;
  const decoded = decodeURIComponent(key);

  const job = await one(
    "SELECT key, company, title, location, url FROM jobs WHERE key = ?",
    [decoded]);
  const pack = await one("SELECT * FROM prep_packs WHERE key = ?", [decoded]);
  resolved(job === null || job, "prep job");

  if (!job) {
    return (
      <div className="sheet">
        <h1>No such role</h1>
        <p className="nothing">Nothing in the corpus has the key {decoded}.</p>
      </div>
    );
  }

  const list = (s) => {
    try {
      const v = JSON.parse(s || "[]");
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  };
  const questions = list(pack?.questions);
  const answers = list(pack?.answers);

  return (
    <div className="sheet">
      <p className="page-intro">
        {job.company} · {job.location || "location not stated"}
      </p>
      <h1>{job.title}</h1>

      {!pack && (
        <p className="nothing">
          No prep pack yet. Build one with{" "}
          <code>python prep_pack.py build {decoded}</code> when the interview is
          actually booked. Nothing here generates it: this page costs nothing to
          open, and that is the point.
        </p>
      )}

      {pack?.note && (
        <p className="alert">
          This pack was REFUSED and its content is deliberately not shown:{" "}
          {pack.note}. Rebuild it. A pack that broke a hard rule must not be
          read an hour before an interview.
        </p>
      )}

      {pack?.summary && (
        <>
          <h2>What the role is</h2>
          <p>{pack.summary}</p>

          <h2>Likely questions</h2>
          <ol>
            {questions.map((q, i) => (
              <li key={q}>
                <strong>{q}</strong>
                {answers[i] ? <p className="sub">{answers[i]}</p> : null}
              </li>
            ))}
          </ol>

          <h2>Ask them</h2>
          <ul>{list(pack.ask_them).map((q) => <li key={q}>{q}</li>)}</ul>

          <h2>Citizenship, clearance, degree</h2>
          <p>{pack.position}</p>

          <p className="note">
            Built {String(pack.created_at).slice(0, 10)} by {pack.model}. Every
            fact traces to profile.json, projects.md and the two resumes; the
            generator is not allowed to research the company, because a
            confident wrong fact about their own employer is the worst thing to
            carry into the room.
          </p>
        </>
      )}

      {job.url && (
        <p className="note">
          <a href={job.url} target="_blank" rel="noreferrer noopener">
            The posting
          </a>
        </p>
      )}
    </div>
  );
}
