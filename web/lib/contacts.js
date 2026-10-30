/**
 * People, and everything that has happened with them.
 *
 * Reads driver.js directly rather than db.js, because db.js imports THIS file —
 * going the other way would be a cycle. That was true when this file only read
 * contacts and it is still true now that it writes them.
 *
 * WHAT CHANGED AND WHY. This used to read contacts.csv, a file that is
 * gitignored because it holds OTHER PEOPLE'S names and contact details — which
 * meant it could never exist on Vercel, and the deployed app could never show a
 * single contact. Phase J moved the read to the table. What was still missing
 * was any way to WRITE one, or to record that anything had happened: so the
 * table stayed empty, Daily's "Follow-ups owed" was permanently a headstone,
 * and the highest-leverage feature in the tool could not be used at all.
 *
 * The rules that decide what is owed, and what a contact's status is, are in
 * lib/people.js and are pure. This file only fetches and stores.
 */
import { all, one, run } from "./driver.js";
import { today as todayLocal, daysSince } from "./day.js";
import { once } from "./once.js";
import { DEFAULTS, rejectWrite } from "./card.js";
import { derivedStatus, sortInteractions, owedFollowUps, INTERACTION_KEYS,
         CHANNEL_KEYS, SOURCE_KEYS, WARMTH_KEYS } from "./people.js";
import { SECTION_KEYS, FIELD_KEYS, SEED, validYm, AFFIRMABLE, affirmKey } from "./sf86.js";

// Calendar days since, from day.js. This was `Math.floor` over an instant
// minus midnight UTC, which reads a day HIGH for the seven hours after 5pm
// Pacific — the mirror of the countdown bug, in the direction that makes a
// follow-up look more overdue than it is.
const days = (iso) => daysSince(iso);

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
// the owner's date, not the server's — a follow-up logged at 6pm Pacific must not
// be recorded as tomorrow.
const today = () => todayLocal();

/**
 * The contacts table, on its own.
 *
 * The three columns added by migration 002 are selected by name like every
 * other, so a database that has not had the migration applied throws here
 * rather than returning rows with three silently-undefined fields. The catch
 * below turns that into an empty list, which is the same answer as "no contacts
 * yet" — see getPeople() for why that is not good enough and what it does
 * instead.
 */
async function _rawContacts() {
  return all(
    `SELECT id, name, company, role, channel, source, job_key, target_role,
            status, first_touch, last_touch, touch_count, next_touch, replied,
            notes, created_at, linkedin_url, email, warmth
     FROM contacts`);
}

async function _rawInteractions() {
  return all(
    `SELECT id, contact_id, type, channel, note, occurred_at, created_at
     FROM interactions`);
}

/**
 * Every contact with their interactions attached, and a DERIVED status.
 *
 * Returns `{ people, ready }`. `ready` is false when the tables are not there —
 * which is a different fact from "nobody has been added yet", and the two look
 * identical on screen unless something carries the difference. That confusion
 * is exactly what made the old contacts.csv read invisible for weeks: the page
 * rendered "None owed" and looked like a quiet day.
 */
async function _getPeople() {
  let contacts;
  let interactions;
  try {
    contacts = await rawContacts();
    interactions = await rawInteractions();
  } catch {
    return { people: [], ready: false };
  }

  const byContact = new Map();
  for (const i of interactions) {
    const list = byContact.get(i.contact_id) || [];
    list.push(i);
    byContact.set(i.contact_id, list);
  }

  const people = contacts.map((c) => {
    const list = sortInteractions(byContact.get(c.id) || []);
    const latest = list[0] || null;
    return {
      ...c,
      touch_count: Number(c.touch_count || 0),
      interactions: list,
      latest,
      // DERIVED, never the stored column. See derivedStatus() for why there are
      // two and why only one of them is read.
      derived: derivedStatus(list),
      lastActivity: latest ? latest.occurred_at : null,
      daysSinceActivity: latest ? days(latest.occurred_at) : null,
      messagesSent: list.filter((i) => i.type === "outreach_sent").length,
      hasReferral: list.some(
        (i) => i.type === "referral_received" || i.type === "referral_asked"),
      referred: list.some((i) => i.type === "referral_received"),
    };
  });

  // TOTAL: name can repeat, id cannot.
  people.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))
                     || String(a.id).localeCompare(String(b.id)));
  return { people, ready: true };
}

/**
 * Kept for the callers that predate interactions.
 *
 * `due` here is the OLD next_touch column, written by contacts.py. Daily no
 * longer uses it — owedFollowUps() in lib/people.js computes obligations from
 * what actually happened — but contacts.py is still a writer of record and
 * nothing in this repository deletes.
 */
export async function getContacts() {
  const { people } = await getPeople();
  return people.map((c) => ({
    ...c,
    daysSinceTouch: c.daysSinceActivity ?? days(c.last_touch),
    dueIn: c.next_touch ? -days(c.next_touch) : null,
    due: !!c.next_touch && days(c.next_touch) >= 0
         && !["replied", "met", "no_reply", "closed"].includes(c.status),
    cadenceDone: c.messagesSent >= 3,
  }));
}

/**
 * Networking state per company, folded into the company view rather than a
 * separate tab nobody opens.
 *
 * `referred` counts people who ACTUALLY REFERRED, and `asked` counts people who
 * were asked. They are two numbers about two different populations, so they are
 * returned separately and never summed — the referral shield in Phase 3e turns
 * on whether either is non-zero and says which.
 */
export async function contactsByCompany() {
  const { people } = await getPeople();
  // What is owed, per person, computed once — the Companies page shows a count
  // and the People page shows the items, and they have to be the same rule or
  // one of the two pages is lying about how much is waiting.
  const owedBy = new Set(owedFollowUps(people).map((o) => o.id));

  const map = new Map();
  for (const c of people) {
    const e = map.get(c.company)
      || { n: 0, replied: 0, referred: 0, asked: 0, due: 0, lastTouch: null };
    e.n++;
    if (c.derived === "in_conversation" || c.derived === "referred") e.replied++;
    if (c.referred) e.referred++;
    if (c.hasReferral) e.asked++;
    if (owedBy.has(c.id)) e.due++;
    if (c.lastActivity && (!e.lastTouch || c.lastActivity > e.lastTouch)) {
      e.lastTouch = c.lastActivity;
    }
    map.set(c.company, e);
  }
  for (const [, e] of map) e.daysSinceTouch = days(e.lastTouch);
  return map;
}

/**
 * Company slugs where a referral is in motion — asked for, or already given.
 *
 * Either counts. The question the shield asks is whether anything is moving,
 * not whether it has landed, and a referral that has been asked for is a
 * conversation already happening.
 */
export async function referralCompanies() {
  const out = new Set();
  for (const [company, e] of await contactsByCompany()) {
    if (e.referred > 0 || e.asked > 0) out.add(company);
  }
  return out;
}

/* -------------------------------------------------------------------- writes */

const id = (prefix) =>
  `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Add a person.
 *
 * NAME AND COMPANY ARE THE ONLY REQUIRED FIELDS, deliberately. Every extra
 * required field is a reason to close the form and do it later, and "later" is
 * how the contacts table stayed empty for a month. Everything else can be
 * filled in from the row afterwards.
 *
 * `created_at` is set here and it is NOT first_touch. That distinction has
 * already caused one silent always-zero bug: the weekly cadence counted
 * first_touch, which is when the first MESSAGE went out, so a name entered
 * today never counted and the networking tier fired forever while appearing to
 * measure something.
 */
export async function addContact({
  name, company, role = null, source = null, linkedin_url = null,
  email = null, warmth = null, notes = null,
} = {}) {
  const n = String(name || "").trim();
  const co = String(company || "").trim();
  if (!n) throw new Error("a contact needs a name");
  if (!co) throw new Error("a contact needs a company");
  if (source && !SOURCE_KEYS.includes(source)) throw new Error("unknown source");
  if (warmth && !WARMTH_KEYS.includes(warmth)) throw new Error("unknown warmth");

  const key = id("p");
  await run(
    `INSERT INTO contacts
       (id, name, company, role, source, linkedin_url, email, warmth, notes,
        status, touch_count, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO NOTHING`,
    [key, n, co, role || null, source || null, linkedin_url || null,
     email || null, warmth || "cold", notes || null, "to_contact", 0, stamp()]);
  return key;
}

/**
 * Record something that happened.
 *
 * INSERT-ONLY. Nothing here updates a status column, because there isn't one
 * being read: status is derived from these rows, so the only way to be wrong
 * about where a relationship stands is to be wrong about what happened.
 *
 * `occurred_at` defaults to today rather than to now-with-a-time, because every
 * rule that reads it works in whole days and a timestamp would invite an
 * off-by-one on the day of.
 */
export async function logInteraction({
  contact_id, type, channel = null, note = null, occurred_at = null,
} = {}) {
  if (!contact_id) throw new Error("which contact?");
  if (!INTERACTION_KEYS.includes(type)) throw new Error("unknown interaction type");
  if (channel && !CHANNEL_KEYS.includes(channel)) throw new Error("unknown channel");
  const when = occurred_at || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) throw new Error("date must be YYYY-MM-DD");

  const exists = await one("SELECT id FROM contacts WHERE id = ?", [contact_id]);
  if (!exists) throw new Error("no such contact");

  const key = id("ix");
  await run(
    `INSERT INTO interactions (id, contact_id, type, channel, note, occurred_at, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [key, contact_id, type, channel || null, note || null, when, stamp()]);

  // last_touch and touch_count are the CSV era's columns and contacts.py still
  // reads them. Kept in step so the CLI does not disagree with the app about a
  // person it can also see; nothing in the web app reads either.
  if (type === "outreach_sent") {
    const n = await one(
      "SELECT COUNT(*) AS n FROM interactions WHERE contact_id = ? AND type = 'outreach_sent'",
      [contact_id]);
    await run(
      `UPDATE contacts SET last_touch = ?, touch_count = ?,
              first_touch = COALESCE(first_touch, ?) WHERE id = ?`,
      [when, Number(n?.n || 1), when, contact_id]);
  } else {
    await run("UPDATE contacts SET last_touch = ? WHERE id = ?", [when, contact_id]);
  }
  return key;
}

/**
 * Undo the thing just logged — the toast's other half.
 *
 * This is the only DELETE in the whole data layer, and it is fenced so that it
 * stays an UNDO rather than becoming a way to destroy history. Everything else
 * here is insert-only on purpose: "messaged, no reply, messaged again, no
 * reply" is the fact that stops the cadence at two, and a tool that can quietly
 * remove the middle of that story cannot be trusted to stop.
 *
 * The fence is time. A row can be removed for UNDO_WINDOW_MINUTES after it was
 * created and not one second longer, so it covers "I clicked the wrong button"
 * and covers nothing else. Past that the honest correction is another
 * interaction saying what really happened.
 */
export const UNDO_WINDOW_MINUTES = 10;

export async function undoInteraction(interactionId) {
  if (!interactionId || !String(interactionId).startsWith("ix:")) {
    throw new Error("not an interaction id");
  }
  const row = await one(
    "SELECT id, created_at FROM interactions WHERE id = ?", [interactionId]);
  if (!row) throw new Error("nothing to undo");
  const age = (Date.now() - Date.parse(row.created_at)) / 60000;
  if (!Number.isFinite(age) || age > UNDO_WINDOW_MINUTES) {
    throw new Error(
      `too late to undo — log what actually happened instead`);
  }
  await run("DELETE FROM interactions WHERE id = ?", [interactionId]);
  return { id: interactionId };
}

/* --------------------------------------------------------------------- sf86
 *
 * Lives in this file rather than db.js for the same reason contacts do: it
 * holds OTHER PEOPLE'S names and contact details — supervisors, foreign
 * contacts — which is the category CLAUDE.md keeps out of the repository
 * entirely. Nothing writes any of it to disk.
 */

/** Every row of the pack. Empty list when the table is absent, plus a flag. */
export async function getSf86() {
  try {
    return {
      rows: await all(
        `SELECT id, section, label, person, contact, purpose, country,
                from_ym, to_ym, sort, updated_at
         FROM sf86_entries ORDER BY section, sort, id`),
      ready: true,
    };
  } catch {
    return { rows: [], ready: false };
  }
}

/**
 * Add a row. Returns its id so the client can focus the first field.
 *
 * `sort` is assigned from the current maximum rather than from the row count,
 * so deleting a row cannot make a later insert collide with an existing one and
 * leave two rows tied — which is how a list a human is reading down reshuffles
 * under them.
 */
export async function addSf86Row(section, values = {}) {
  if (!SECTION_KEYS.includes(section)) throw new Error("unknown section");
  const key = id("sf");
  const max = await one(
    "SELECT MAX(sort) AS m FROM sf86_entries WHERE section = ?", [section]);
  await run(
    `INSERT INTO sf86_entries
       (id, section, label, person, contact, purpose, country, from_ym, to_ym, sort, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [key, section, values.label ?? null, values.person ?? null,
     values.contact ?? null, values.purpose ?? null, values.country ?? null,
     values.from_ym ?? null, values.to_ym ?? null,
     Number(max?.m ?? 0) + 1, stamp()]);
  return key;
}

/**
 * Save ONE field. This is what autosave-on-blur calls.
 *
 * One field at a time rather than the whole row, deliberately: a whole-row save
 * would send stale values for every field the user has not touched, and two
 * fields blurred in quick succession would race, with the loser silently
 * writing back what it read when the row rendered.
 */
export async function setSf86Field(rowId, field, value) {
  if (!FIELD_KEYS.includes(field)) throw new Error("unknown field");
  if ((field === "from_ym" || field === "to_ym") && value && !validYm(value)) {
    throw new Error("dates are YYYY-MM");
  }
  const exists = await one("SELECT id FROM sf86_entries WHERE id = ?", [rowId]);
  if (!exists) throw new Error("no such row");
  // The column name is interpolated, so it is checked against a closed list
  // above rather than trusted. Every other value here is a placeholder.
  await run(
    `UPDATE sf86_entries SET ${field} = ?, updated_at = ? WHERE id = ?`,
    [value === "" ? null : value, stamp(), rowId]);
  return { id: rowId, field };
}

/** Remove a row. A typo'd address is not history worth keeping. */
export async function deleteSf86Row(rowId) {
  if (!rowId || !String(rowId).startsWith("sf:")) throw new Error("not a pack row");
  await run("DELETE FROM sf86_entries WHERE id = ?", [rowId]);
  return { id: rowId };
}

/**
 * The "none" affirmations, by section: an ISO timestamp, or null.
 *
 * Its own field in `settings`, not a derivation from the row count. An
 * unanswered section and an affirmed-none section must be different things
 * in the database — see AFFIRMABLE in lib/sf86.js.
 */
export async function getSf86Affirmations() {
  const out = {};
  for (const s of AFFIRMABLE) out[s] = await getSetting(affirmKey(s));
  return out;
}

/** Record "none" (with the time it was said), or withdraw it (null). */
export async function setSf86Affirmation(section, on) {
  if (!AFFIRMABLE.includes(section)) throw new Error("that section cannot be answered none");
  const value = on ? stamp() : null;
  await setSetting(affirmKey(section), value);
  return { section, affirmed: value };
}

/**
 * Put the SEED rows in, once, the first time the page is opened. The shipped
 * SEED is empty (see lib/sf86.js), so this writes nothing unless an owner
 * adds rows there.
 *
 * Guarded on the section being COMPLETELY empty, not on a flag: a flag is a
 * second source of truth that can disagree with the table, and the failure mode
 * would be re-seeding duplicate trips onto a pack someone had curated.
 */
export async function seedSf86() {
  const { rows, ready } = await getSf86();
  if (!ready) return 0;
  if (rows.some((r) => r.section === "travel")) return 0;
  let n = 0;
  for (const s of SEED) {
    const { section, ...values } = s;
    await addSf86Row(section, values);
    n += 1;
  }
  return n;
}

/* ------------------------------------------------------------------ settings */

/** Small editable text the app owns. Returns null when unset — never a guess. */
export async function getSetting(key) {
  try {
    const r = await one("SELECT value FROM settings WHERE key = ?", [key]);
    return r?.value ?? null;
  } catch {
    return null;
  }
}

export async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                     updated_at = excluded.updated_at`,
    [key, value, stamp()]);
  return { key };
}

/* --------------------------------------------------------------- the profile
 *
 * The 25 fields an application form asks for every time. ONE ROW, keyed 'me',
 * so there is never a choice to make about which profile is the real one.
 *
 * It lives beside contacts rather than in db.js because it is the same kind of
 * data with the same handling rules: the owner's address and phone number, which is
 * exactly what the repo's deny list exists to keep out of a commit.
 */

/** The profile as stored, over the defaults. Never throws on a missing table. */
export async function getProfile() {
  try {
    const row = await one("SELECT * FROM profile WHERE id = ?", ["me"]);
    // `ready` distinguishes "the migration has not run" from "he has not filled
    // it in" — two states that look identical on screen and mean opposite
    // things about what to do next.
    return { profile: { ...DEFAULTS, ...(row || {}) }, ready: true, seeded: !!row };
  } catch {
    return { profile: { ...DEFAULTS }, ready: false, seeded: false };
  }
}

/**
 * Write one field. Autosave on blur, so this is called a lot and with one key.
 *
 * The rule check is in lib/card.js and runs HERE as well as in the API route,
 * because a second write path arriving later must not be able to skip it. It
 * refuses rather than sanitising: silently rewriting what the owner typed would
 * mean the box says one thing and the database holds another.
 */
export async function setProfileField(key, value) {
  const err = rejectWrite(key, value);
  if (err) throw new Error(err);

  const now = stamp();
  const existing = await one("SELECT id FROM profile WHERE id = ?", ["me"]);
  if (!existing) {
    const cols = ["id", ...Object.keys(DEFAULTS).filter((k) => k !== "id"), "updated_at"];
    const vals = cols.map((c) => (c === "updated_at" ? now : DEFAULTS[c] ?? null));
    await run(
      `INSERT INTO profile (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`,
      vals);
  }
  await run(`UPDATE profile SET ${key} = ?, updated_at = ? WHERE id = ?`,
            [value === "" ? null : value, now, "me"]);
  return { key, value };
}

/** Everything the Pulse page needs, in one place. */
export async function pulseRows() {
  try {
    const [contacts, interactions] = await Promise.all([rawContacts(), rawInteractions()]);
    return { contacts, interactions, ready: true };
  } catch {
    return { contacts: [], interactions: [], ready: false };
  }
}

/* ------------------------------------------------ once per request
 *
 * contacts and interactions were each read four times in one render.
 *
 * Same question, same answer, one query. See lib/once.js: React's cache
 * is scoped to a single render and is a NO-OP outside one, so the CLI
 * scripts that import this module are unaffected and can never serve a
 * stale row from a cache they cannot see.
 */
const rawContacts = once(_rawContacts);
const rawInteractions = once(_rawInteractions);
export const getPeople = once(_getPeople);
