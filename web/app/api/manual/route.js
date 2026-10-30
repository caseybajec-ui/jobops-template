import {
  createManualApplication, recordManualEvent, setManualReferral,
  setManualNotes, undoManualApplication,
} from "@/lib/applications";
import { LIFECYCLE_KEYS } from "@/lib/lifecycle";

/**
 * POST /api/manual -- applications the owner submitted BY HAND, to things the
 * fetcher cannot see.
 *
 * THIS USED TO LIVE AT /api/applications AND WAS SILENTLY DELETED. The apply-log
 * paste box (lib/grok.js, from the external apply bot) took over that path on
 * 2026-09-08 and replaced this handler wholesale, while TrackApplication.js and
 * CompositeToday.js kept posting {action: "create"} to it -- every manual
 * submission from then on got "nothing pasted" and the submissions counter
 * could never count one. Two different records of "I applied" need two routes:
 * this one is the owner's own tracker; /api/applications is the bot's log.
 *
 *   { action: "create",   firm_label, program_name, ... }   record a submission
 *   { action: "advance",  id, status }                      move a stage
 *   { action: "referral", id, referral }                    answer with/without
 *   { action: "notes",    id, notes }                       edit the notes
 *   { action: "undo",     id }                              take back, <60s
 *
 * Applications to things the fetcher cannot see — consulting, VC, big-tech APM.
 * The only way the browser writes them, validated here as well as in the data
 * layer, because the route is the boundary the network reaches.
 *
 * NOTHING IS SUBMITTED FROM HERE. This records that the owner submitted something
 * themselves, on the firm's own site. There is no code in this repository that
 * files an application and there is not going to be.
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

  if (action === "create") {
    if (typeof body.firm_label !== "string" || !body.firm_label.trim()) {
      return bad("which firm?");
    }
    if (typeof body.program_name !== "string" || !body.program_name.trim()) {
      return bad("which programme?");
    }
    if (body.source && !["window", "direct"].includes(body.source)) {
      return bad("source must be window or direct");
    }
    if (body.status && !LIFECYCLE_KEYS.includes(body.status)) {
      return bad(`status must be one of ${LIFECYCLE_KEYS.join(", ")}`);
    }
    // TRI-STATE. null means "not asked", and it is a real answer: this column
    // is the only evidence about whether referrals work, and coercing an
    // unanswered question to false invents evidence against it.
    if (body.referral !== null && body.referral !== undefined
        && typeof body.referral !== "boolean") {
      return bad("referral must be true, false, or omitted");
    }
    if (body.at && !/^\d{4}-\d{2}-\d{2}/.test(body.at)) {
      return bad("that is not a date");
    }
    try {
      return Response.json({ id: await createManualApplication(body) });
    } catch (e) {
      return Response.json({ error: e.message || "could not record that" }, { status: 500 });
    }
  }

  if (action === "advance") {
    if (typeof body.id !== "string" || !body.id) return bad("which application?");
    if (!LIFECYCLE_KEYS.includes(body.status)) {
      return bad(`status must be one of ${LIFECYCLE_KEYS.join(", ")}`);
    }
    try {
      return Response.json(await recordManualEvent(body.id, body.status, { note: body.note || null }));
    } catch (e) {
      return Response.json({ error: e.message || "could not record that" }, { status: 500 });
    }
  }

  if (action === "referral") {
    if (typeof body.id !== "string" || !body.id) return bad("which application?");
    if (body.referral !== null && typeof body.referral !== "boolean") {
      return bad("referral must be true, false, or null");
    }
    try {
      return Response.json(await setManualReferral(body.id, body.referral));
    } catch (e) {
      return Response.json({ error: e.message || "could not save that" }, { status: 500 });
    }
  }

  if (action === "notes") {
    if (typeof body.id !== "string" || !body.id) return bad("which application?");
    if (typeof body.notes === "string" && body.notes.length > 4000) {
      return bad("that note is too long");
    }
    try {
      return Response.json(await setManualNotes(body.id, body.notes ?? null));
    } catch {
      return Response.json({ error: "could not save that note" }, { status: 500 });
    }
  }

  if (action === "undo") {
    if (typeof body.id !== "string" || !body.id) return bad("which application?");
    try {
      return Response.json(await undoManualApplication(body.id));
    } catch (e) {
      // 400, not 500: "too late to undo" is a rule being enforced, not a fault,
      // and the message says what to do instead.
      return Response.json({ error: e.message || "could not undo that" }, { status: 400 });
    }
  }

  return bad("unknown action");
}
