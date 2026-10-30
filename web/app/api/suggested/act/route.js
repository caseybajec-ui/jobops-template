import { one, run } from "@/lib/driver";

/**
 * POST /api/suggested/act — promote or skip one suggestion.
 *
 * SESSION-AUTHENTICATED, not bearer. This is the owner tapping a button in his
 * browser; the bearer token belongs to the local reader and is deliberately
 * useless here. A stolen reader token must not be able to create a contact.
 *
 * PROMOTE WRITES A REAL CONTACT and marks the suggestion, in that order. If
 * the contact insert fails the suggestion stays unpromoted, so the row comes
 * back tomorrow rather than vanishing into a state where it is neither.
 *
 * SKIP DOES NOT DELETE. A skip is a decision about TODAY -- deleting the row
 * would let tomorrow's run suggest them again, and the 30-day window in
 * todaysFive() is what makes it a pause rather than a rejection.
 */
export const dynamic = "force-dynamic";

const cid = () => `p:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function POST(req) {
  const { id, action } = await req.json().catch(() => ({}));
  if (!id || !["promote", "skip", "sent"].includes(action)) {
    return Response.json({ error: "id and a known action are required" },
                         { status: 400 });
  }

  const s = await one("SELECT * FROM suggested_contacts WHERE id = ?", [id]);
  if (!s) return Response.json({ error: "no such suggestion" }, { status: 404 });

  if (action === "skip") {
    await run("UPDATE suggested_contacts SET skipped_at = ? WHERE id = ?",
              [new Date().toISOString(), id]);
    return Response.json({ ok: true, action: "skip" });
  }

  // promote and sent both create the contact; "sent" also logs the touch, so
  // the follow-up sequence starts from a real interaction rather than from an
  // assumption that copying meant sending.
  const already = await one(
    "SELECT id FROM contacts WHERE lower(name) = lower(?) AND company = ?",
    [s.name, s.company_slug || s.company]);

  let contactId = already?.id;
  if (!contactId) {
    contactId = cid();
    await run(
      "INSERT INTO contacts (id, name, company, role, source, status, notes, "
      + " linkedin_url, warmth, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [contactId, s.name, s.company_slug || s.company, s.title || null,
       s.source || "suggested", "to_contact",
       // The rank reason travels onto the contact, so months later the row
       // still says why this person was worth writing to.
       s.rank_reason ? `${s.rank_reason}. ${s.raw || ""}`.slice(0, 500) : (s.raw || null),
       s.profile_url || null,
       s.rank <= 3 ? "warm" : "cold", new Date().toISOString()]);
  }

  if (action === "sent") {
    await run(
      "INSERT INTO interactions (id, contact_id, type, occurred_at, note, "
      + " created_at) VALUES (?,?,?,?,?,?)",
      [`i:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
       contactId, "outreach_sent", new Date().toISOString(),
       "sent from Today's Five", new Date().toISOString()]);
  }

  await run("UPDATE suggested_contacts SET promoted_at = ? WHERE id = ?",
            [new Date().toISOString(), id]);
  return Response.json({ ok: true, action, contactId });
}
