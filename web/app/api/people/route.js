import {
  addContact, logInteraction, undoInteraction, setSetting,
} from "@/lib/contacts";
import {
  INTERACTION_KEYS, CHANNEL_KEYS, SOURCE_KEYS, WARMTH_KEYS, TEMPLATE_KEYS,
} from "@/lib/people";

/**
 * POST /api/people
 *
 *   { action: "add",   name, company, ... }        add a person
 *   { action: "log",   contact_id, type, ... }     record what happened
 *   { action: "undo",  id }                        take back the last log
 *   { action: "template", key, body }              edit an outreach template
 *
 * The only way the browser writes anything about a person. Every closed set is
 * checked HERE as well as in lib/contacts.js — the route is the boundary the
 * network reaches, and a value that gets past it is one the UI cannot render.
 *
 * NOTHING HERE SENDS ANYTHING. There is no mail client, no LinkedIn call, no
 * outbound request of any kind, and there is not going to be: CLAUDE.md rule 3
 * says drafts only, the human sends. "Copy message" copies to a clipboard and
 * logs that the owner said he sent it — which is a record of his action, not an
 * action of the tool's.
 */

const bad = (msg) => Response.json({ error: msg }, { status: 400 });

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return bad("expected a JSON body");
  }

  const { action } = body || {};

  /* ------------------------------------------------------------------ add */
  if (action === "add") {
    const { name, company, role = null, source = null, linkedin_url = null,
            email = null, warmth = null, notes = null } = body;
    if (typeof name !== "string" || !name.trim()) return bad("a contact needs a name");
    if (typeof company !== "string" || !company.trim()) return bad("a contact needs a company");
    if (source && !SOURCE_KEYS.includes(source)) return bad("unknown source");
    if (warmth && !WARMTH_KEYS.includes(warmth)) return bad("unknown warmth");
    // A stored link is a link. Anything else in that field is a typo that would
    // render as a dead anchor on the row.
    if (linkedin_url && !/^https?:\/\//i.test(linkedin_url)) {
      return bad("the LinkedIn field wants a full https:// link");
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("that is not an email address");
    try {
      return Response.json({ id: await addContact(body) });
    } catch (e) {
      return Response.json({ error: e.message || "could not add that person" }, { status: 500 });
    }
  }

  /* ------------------------------------------------------------------ log */
  if (action === "log") {
    const { contact_id, type, channel = null, note = null, occurred_at = null } = body;
    if (typeof contact_id !== "string" || !contact_id) return bad("which contact?");
    if (!INTERACTION_KEYS.includes(type)) {
      return bad(`type must be one of ${INTERACTION_KEYS.join(", ")}`);
    }
    if (channel && !CHANNEL_KEYS.includes(channel)) return bad("unknown channel");
    if (occurred_at && !/^\d{4}-\d{2}-\d{2}$/.test(occurred_at)) {
      return bad("date must be YYYY-MM-DD");
    }
    // A date has to be a real one. 2026-02-31 matches the pattern above and is
    // not a day; the same check the window route makes, for the same reason —
    // every cadence rule here does arithmetic on this value.
    if (occurred_at) {
      const d = new Date(occurred_at + "T00:00:00Z");
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== occurred_at) {
        return bad("that is not a real date");
      }
    }
    try {
      return Response.json({ id: await logInteraction(body) });
    } catch (e) {
      return Response.json({ error: e.message || "could not record that" }, { status: 500 });
    }
  }

  /* ----------------------------------------------------------------- undo */
  if (action === "undo") {
    if (typeof body.id !== "string") return bad("which interaction?");
    try {
      return Response.json(await undoInteraction(body.id));
    } catch (e) {
      return Response.json({ error: e.message || "could not undo that" }, { status: 400 });
    }
  }

  /* ------------------------------------------------------------- template */
  if (action === "template") {
    const { key, body: text } = body;
    if (!TEMPLATE_KEYS.includes(key)) return bad("unknown template");
    // null resets to the shipped wording. An empty string would too, and saying
    // so explicitly is better than letting "" mean two things.
    const value = text === null || text === undefined || !String(text).trim()
      ? null
      : String(text);
    if (value && value.length > 8000) return bad("that message is far too long to be one");
    try {
      await setSetting(`template:${key}`, value);
      return Response.json({ key, reset: value === null });
    } catch {
      return Response.json({ error: "could not save that template" }, { status: 500 });
    }
  }

  return bad("unknown action");
}
