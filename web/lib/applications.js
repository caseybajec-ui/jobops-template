/**
 * Applications, both kinds, in one shape.
 *
 * A scraped role and a Workday form are the same thing to the person doing the
 * search — something submitted, waiting, with a number of days attached — and
 * they were two different things to this tool, one of which did not exist. The
 * three consulting applications with the nearest deadline could not be recorded
 * at all, so "In flight" showed the half of the search that mattered least.
 *
 * ONE SHAPE, ONE SET OF RULES. Manual application events are stored in the same
 * columns as role_events precisely so that currentStatus() and inFlight() from
 * lib/lifecycle.js can be handed either without knowing the difference. There is
 * no second implementation of days-in-stage anywhere in here, and there must not
 * be one: the moment there are two, they disagree.
 *
 * Imports db.js and never the other way round. db.js must not import this file
 * or the cycle is immediate — this needs roleLifecycle() and roleLabels() from
 * there, and nothing there needs anything here.
 */
import { all, one, run } from "./driver.js";
import { once } from "./once.js";
import { roleLifecycle, roleLabels } from "./db.js";
import {
  currentStatus, LIFECYCLE_KEYS, NUDGE_AFTER_DAYS, UNDO_WINDOW_SECONDS,
} from "./lifecycle.js";

// Re-exported so callers that already import from here keep working. The
// DEFINITION is in lifecycle.js because that module is pure — see there.
export { UNDO_WINDOW_SECONDS };

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
const id = (p) => `${p}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* ------------------------------------------------------------------- reads */

async function rawApplications() {
  return all(
    `SELECT id, company, firm_label, program_name, class_year, window_id,
            source, notes, created_at, updated_at
     FROM manual_applications`);
}

async function rawEvents() {
  return all(
    `SELECT id, application_id, status, referral, note, at
     FROM manual_application_events`);
}

/**
 * Every manual application with its events attached and its status derived.
 *
 * `ready` is false when the tables are absent, which is a different fact from
 * "none recorded yet" — and the two look identical on screen unless something
 * carries the difference. That confusion is what made reading contacts.csv on
 * Vercel invisible for weeks.
 */
async function _getManualApplications() {
  let rows;
  let events;
  try {
    rows = await rawApplications();
    events = await rawEvents();
  } catch {
    return { applications: [], ready: false };
  }

  const byApp = new Map();
  for (const e of events) {
    const list = byApp.get(e.application_id) || [];
    list.push(e);
    byApp.set(e.application_id, list);
  }

  const applications = rows.map((r) => {
    const own = byApp.get(r.id) || [];
    return { ...r, events: own, current: currentStatus(own) };
  });
  // TOTAL: firm_label repeats across programmes, id cannot.
  applications.sort((a, b) => String(a.firm_label).localeCompare(String(b.firm_label))
                           || String(a.id).localeCompare(String(b.id)));
  return { applications, ready: true };
}

/**
 * Role applications and manual ones, unioned into one list.
 *
 * The shape is fixed by the brief and every caller that counts or lists
 * applications reads it — In flight, the Companies referral tally, the header
 * counts. One query, so those three can never disagree about how many
 * applications exist.
 *
 * A role whose posting has since closed keeps its lifecycle and still appears:
 * that is the case most likely to have gone quiet, and dropping it would hide
 * exactly the applications worth chasing.
 */
export async function listActiveApplications(now = new Date()) {
  const [lifecycle, labels, manual] = await Promise.all([
    roleLifecycle(), roleLabels(), getManualApplications(),
  ]);

  const out = [];

  for (const [groupKey, s] of lifecycle) {
    if (!s) continue;
    const label = labels.get(groupKey);
    const [co, title] = String(groupKey).split("|");
    out.push({
      kind: "role",
      id: groupKey,
      company: label?.company ?? co,
      display_name: label?.display_name ?? co,
      title: label?.title ?? title ?? groupKey,
      status: s.status,
      stageEnteredAt: s.at,
      daysInStage: s.days,
      withReferral: s.referral,
      submittedAt: appliedAt(s.history),
      terminal: s.terminal,
      nudge: s.status === "applied" && (s.days ?? 0) >= NUDGE_AFTER_DAYS,
    });
  }

  for (const a of manual.applications) {
    if (!a.current) continue;   // created but never advanced past nothing
    out.push({
      kind: "manual",
      id: a.id,
      company: a.company || null,
      display_name: a.firm_label,
      title: a.program_name,
      status: a.current.status,
      stageEnteredAt: a.current.at,
      daysInStage: a.current.days,
      withReferral: a.current.referral,
      submittedAt: appliedAt(a.current.history),
      terminal: a.current.terminal,
      nudge: a.current.status === "applied" && (a.current.days ?? 0) >= NUDGE_AFTER_DAYS,
      windowId: a.window_id || null,
      createdAt: a.created_at,
    });
  }

  // Longest-waiting first, like inFlight(): the thing that has not moved is the
  // thing that needs a decision. Total, so two rows entered the same day cannot
  // swap places between loads.
  return out.sort((a, b) => (b.daysInStage ?? 0) - (a.daysInStage ?? 0)
                         || String(a.id).localeCompare(String(b.id)));
}

/** When the `applied` event happened, from a history array. */
function appliedAt(history = []) {
  const ev = [...history].reverse().find((e) => e.status === "applied");
  return ev ? ev.at : null;
}

/**
 * What the submissions counter needs, from the SAME union every other count
 * reads. Role applications and manual ones together.
 *
 * NOT A SECOND QUERY. In flight, the Companies referral tally and the header
 * counts all read listActiveApplications(), and a fourth definition of "how
 * many applications exist" is how two numbers on one screen start disagreeing.
 *
 * `submittedAt` is when the `applied` event happened, which is null for a row
 * that went straight to rejected without one. submissionCounts() handles that
 * deliberately: it counts toward the total and toward no week.
 */
export async function submissionSnapshot(now = new Date()) {
  const rows = await listActiveApplications(now);
  return {
    submissions: rows.map((a) => ({ stage: a.status, at: a.submittedAt })),
    interviews: rows.map((a) => ({ stage: a.status })),
  };
}

/** Still in play. Same predicate inFlight() uses, over the union. */
export async function listInFlight(now = new Date()) {
  return (await listActiveApplications(now)).filter((a) => !a.terminal);
}

/** Which windows already have an application, so Forecast can say so. */
export async function windowsApplied() {
  const { applications } = await getManualApplications();
  const out = new Set();
  for (const a of applications) {
    if (a.window_id && a.current) out.add(a.window_id);
  }
  return out;
}

/* ------------------------------------------------------------------ writes */

/**
 * Record an application to something the fetcher cannot see.
 *
 * `status` defaults to `applied` because that is what the composite card does —
 * ticking a firm means it went in. Forecast's "track this" path passes `saved`
 * for something not yet submitted.
 */
export async function createManualApplication({
  company = null, firm_label, program_name, class_year = null,
  window_id = null, source = "window", notes = null,
  status = "applied", referral = null, at = null,
} = {}) {
  const label = String(firm_label || "").trim();
  const prog = String(program_name || "").trim();
  if (!label) throw new Error("an application needs a firm");
  if (!prog) throw new Error("an application needs a programme");
  if (!["window", "direct"].includes(source)) throw new Error("unknown source");
  if (!LIFECYCLE_KEYS.includes(status)) throw new Error(`unknown status: ${status}`);

  const now = stamp();
  const key = id("ma");
  await run(
    `INSERT INTO manual_applications
       (id, company, firm_label, program_name, class_year, window_id, source,
        notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [key, company || null, label, prog, class_year ?? null, window_id || null,
     source, notes || null, now, now]);

  await recordManualEvent(key, status, { referral, at: at || now });
  return key;
}

/**
 * Advance a manual application. INSERT-ONLY, like role_events.
 *
 * Nothing updates a status column, because there isn't one being read: status
 * is derived from these rows, so the only way to be wrong about where an
 * application stands is to be wrong about what happened to it.
 */
export async function recordManualEvent(applicationId, status, { referral = null, note = null, at = null } = {}) {
  if (!LIFECYCLE_KEYS.includes(status)) throw new Error(`unknown status: ${status}`);
  const exists = await one("SELECT id FROM manual_applications WHERE id = ?", [applicationId]);
  if (!exists) throw new Error("no such application");
  const when = at || stamp();
  await run(
    `INSERT INTO manual_application_events (id, application_id, status, referral, note, at)
     VALUES (?,?,?,?,?,?)`,
    [id("mev"), applicationId, status,
     referral === null || referral === undefined ? null : (referral ? 1 : 0),
     note || null, when]);
  await run("UPDATE manual_applications SET updated_at = ? WHERE id = ?", [stamp(), applicationId]);
  return { id: applicationId, status, at: when };
}

/**
 * Answer the with-or-without-a-referral question after the fact.
 *
 * Writes onto the EXISTING applied event rather than adding another one: the
 * answer is a property of how he got in, not a new thing that happened, and a
 * second `applied` event would read as applying twice.
 */
export async function setManualReferral(applicationId, referral) {
  const ev = await one(
    `SELECT id FROM manual_application_events
     WHERE application_id = ? AND status = 'applied' ORDER BY at, id LIMIT 1`,
    [applicationId]);
  if (!ev) throw new Error("that application has no applied event to attach it to");
  await run(
    "UPDATE manual_application_events SET referral = ? WHERE id = ?",
    [referral === null || referral === undefined ? null : (referral ? 1 : 0), ev.id]);
  await run("UPDATE manual_applications SET updated_at = ? WHERE id = ?", [stamp(), applicationId]);
  return { id: applicationId, referral };
}

export async function setManualNotes(applicationId, notes) {
  await run("UPDATE manual_applications SET notes = ?, updated_at = ? WHERE id = ?",
    [notes || null, stamp(), applicationId]);
  return { id: applicationId };
}

/**
 * Take back an application recorded in the last minute.
 *
 * The only DELETE here, and it is fenced by time so it stays an undo. Past the
 * window this refuses and says what to do instead — an application that really
 * was withdrawn is a `rejected`/`ghosted` event, not a hole in the history.
 */
export async function undoManualApplication(applicationId) {
  const row = await one(
    "SELECT id, created_at FROM manual_applications WHERE id = ?", [applicationId]);
  if (!row) throw new Error("nothing to undo");
  const age = (Date.now() - Date.parse(row.created_at)) / 1000;
  if (!Number.isFinite(age) || age > UNDO_WINDOW_SECONDS) {
    throw new Error("too late to undo — mark it withdrawn or rejected instead");
  }
  await run("DELETE FROM manual_application_events WHERE application_id = ?", [applicationId]);
  await run("DELETE FROM manual_applications WHERE id = ?", [applicationId]);
  return { id: applicationId };
}

/* ------------------------------------------------ once per request
 *
 * manual applications were read twice in one render.
 *
 * Same question, same answer, one query. See lib/once.js: React's cache
 * is scoped to a single render and is a NO-OP outside one, so the CLI
 * scripts that import this module are unaffected and can never serve a
 * stale row from a cache they cannot see.
 */
export const getManualApplications = once(_getManualApplications);
