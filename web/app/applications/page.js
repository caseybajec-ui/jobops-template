import { all } from "@/lib/driver";
import { COMPANY_NAMES, GROK } from "@/lib/config.generated";
import { grokStale, displayEmployer } from "@/lib/grok";
import ApplyLogPaste from "../ApplyLogPaste";
import Unmatched from "../Unmatched";

/**
 * What the owner actually applied to.
 *
 * EVERY OTHER PAGE SHOWS WHAT THE TOOL PREPARED -- roles found, scores
 * computed, packs written, people suggested. None of them could see whether
 * any of it turned into an application, which is how the audit arrived at
 * zero applications, zero contacts touched and 121 packs unused as a finding
 * the system itself had no way to notice.
 *
 * FED BY PASTE, never by a request to anything. There is no client for the bot
 * that writes the log, no webhook and no credential.
 */
export const dynamic = "force-dynamic";

const fmt = (d) => String(d || "").slice(0, 10);

/**
 * LITERAL CLASS NAMES, not a template.
 *
 * The first version built `st-${status}`, which reads fine and is invisible to
 * test_classes.mjs -- it can only see the prefix, so it reported a class with
 * no rule and could never have told anyone that a status of "rate-limited"
 * renders unstyled. An unknown status is legitimately possible here:
 * parsePipeLog keeps a word it does not recognise rather than coercing it to
 * success, so the set of statuses is open and the set of CLASSES is closed.
 */
const STATUS_CLASS = {
  blocked: "st-blocked",
  skipped: "st-skipped",
  "no posting": "st-noposting",
};

export default async function Page() {
  const rows = await all(
    "SELECT id, applied_date, channel, employer_raw, employer_id, role, "
    + " location, status, notes FROM applied_apps "
    + "ORDER BY applied_date DESC, employer_raw, id LIMIT 500").catch(() => null);
  const lastImport = await one_(
    // COALESCE(updated_at, created_at): a re-import that only UPDATES rows is
    // still an import, and the warning this feeds is about silence. Both
    // doors count -- the paste box and the bot's token route.
    "SELECT max(COALESCE(updated_at, created_at)) AS at FROM applied_apps "
    + "WHERE source IN (?, ?)",
    ["grok_paste", "bot_api"]);

  // NULL MEANS THE READ FAILED, and it must not render as an empty table.
  // "Nothing imported yet" and "the database is unreachable" are different
  // findings and this page has been the place that conflates them before.
  if (rows === null) {
    return (
      <main>
        <h1>Applications</h1>
        <p className="importfail" role="alert">
          Could not read applied_apps. This is a failure to look, not a report
          that nothing is there.
        </p>
      </main>
    );
  }

  const unmatched = [...new Set(
    rows.filter((r) => !r.employer_id).map((r) => r.employer_raw))].sort();
  const stale = grokStale(lastImport, new Date().toISOString(), GROK.staleDays);

  return (
    <main>
      <h1>Applications</h1>

      <section>
        <h2>Import the apply log</h2>
        <ApplyLogPaste />
      </section>

      {stale.never && (
        <p className="sub" data-testid="never-imported">
          Nothing has been imported yet. This section is its own setup action:
          paste a log above and it starts counting.
        </p>
      )}
      {stale.stale && (
        <p className="importfail" role="alert" data-testid="import-stale">
          No apply log has been imported for {Math.floor(stale.days)} days.
          Either nothing is being submitted, or the log has stopped arriving —
          those look identical from here, which is why this line exists.
        </p>
      )}

      {unmatched.length > 0 && (
        <section>
          <h2>Unmatched employers ({unmatched.length})</h2>
          <p className="sub">
            These applications are recorded. The employer could not be matched
            to a company in companies.yaml by an exact or clean-suffix name, and
            nothing here guesses — a wrong match files an application against
            the wrong company and looks exactly like a right one afterwards.
          </p>
          <Unmatched names={unmatched} known={COMPANY_NAMES} />
        </section>
      )}

      <section>
        <h2>{rows.length} recorded</h2>
        {rows.length === 0 ? (
          <p className="sub">Nothing yet.</p>
        ) : (
          <div className="tablewrap">
            <table className="apps">
              <thead>
                <tr>
                  <th>Date</th><th>Employer</th><th>Role</th>
                  <th>Status</th><th>Channel</th><th>Where</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const who = displayEmployer(r, COMPANY_NAMES);
                  return (
                  <tr key={r.id} className={STATUS_CLASS[r.status] || ""}>
                    <td className="nowrap">{fmt(r.applied_date)}</td>
                    <td>
                      {who.name}
                      {/* The log's own words, kept beside the canonical name
                          when they differ. This is the audit trail: a wrong
                          company link is only findable by comparing what is
                          shown against what the bot actually wrote. */}
                      {who.raw && (
                        <span className="sub"> ({who.raw})</span>
                      )}
                      {!r.employer_id && <span className="tag"> unmatched</span>}
                    </td>
                    <td>{r.role || <span className="sub">—</span>}</td>
                    <td>{r.status}</td>
                    <td>{r.channel || ""}</td>
                    <td>{r.location || ""}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

/** `one` from the driver, but returning the scalar this page wants. */
async function one_(sql, params) {
  const r = await all(sql, params).catch(() => null);
  return r && r[0] ? r[0].at : null;
}
