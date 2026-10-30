import { addSf86Row, setSf86Field, deleteSf86Row, setSf86Affirmation } from "@/lib/contacts";
import { SECTION_KEYS, FIELD_KEYS, AFFIRMABLE, validYm } from "@/lib/sf86";

/**
 * POST /api/sf86
 *
 *   { action: "add",    section }              a blank row in that section
 *   { action: "save",   id, field, value }     autosave, one field
 *   { action: "delete", id }                   remove a row
 *   { action: "affirm", section, value }       "none" for a section, or withdraw it
 *
 * ONE FIELD PER SAVE. A whole-row save would send stale values for every field
 * the user has not touched, and two fields blurred in quick succession would
 * race — with the loser writing back what it read when the row first rendered.
 *
 * NOTHING IS SUBMITTED ANYWHERE. This is a notebook for facts the SF-86 will
 * ask for; there is no endpoint that files anything and there will not be one.
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

  if (action === "add") {
    if (!SECTION_KEYS.includes(body.section)) return bad("unknown section");
    try {
      return Response.json({ id: await addSf86Row(body.section) });
    } catch {
      return Response.json({ error: "could not add that row" }, { status: 500 });
    }
  }

  if (action === "save") {
    if (typeof body.id !== "string" || !body.id) return bad("which row?");
    if (!FIELD_KEYS.includes(body.field)) return bad("unknown field");
    const value = body.value === null || body.value === undefined
      ? "" : String(body.value);
    if (value.length > 500) return bad("that is too long for this field");
    // A date has to be a real month. The gap detector does arithmetic on these,
    // and "2026-13" would silently produce a nonsense span rather than an error.
    if ((body.field === "from_ym" || body.field === "to_ym")
        && value && !validYm(value)) {
      return bad("dates are a month and a year");
    }
    try {
      return Response.json(await setSf86Field(body.id, body.field, value));
    } catch (e) {
      return Response.json({ error: e.message || "could not save that" }, { status: 500 });
    }
  }

  if (action === "affirm") {
    if (!AFFIRMABLE.includes(body.section)) return bad("that section cannot be answered none");
    if (typeof body.value !== "boolean") return bad("value must be true or false");
    try {
      return Response.json(await setSf86Affirmation(body.section, body.value));
    } catch (e) {
      return Response.json({ error: e.message || "could not record that" }, { status: 500 });
    }
  }

  if (action === "delete") {
    if (typeof body.id !== "string") return bad("which row?");
    try {
      return Response.json(await deleteSf86Row(body.id));
    } catch (e) {
      return Response.json({ error: e.message || "could not remove that" }, { status: 500 });
    }
  }

  return bad("unknown action");
}
