import { addItem, setItemDue, splitItem, recordAction } from "@/lib/db";
import { daysFromToday } from "@/lib/day";

/**
 * POST /api/items
 *
 *   { title, note?, dueInDays? }   add an on-you item
 *   { id, dueAt }                  change an item's due date
 *   { id, dueAt, defer: true }     the same, recorded as a deferral
 *   { id, action: "stuck" }        record it as stuck, and split it if it has
 *                                  pre-authored steps
 *
 * POST only, validated here, written through lib/db.js.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { id, dueAt, title, note = null, dueInDays = null, action = null,
          defer = false } = body || {};

  // --- stuck --------------------------------------------------------------
  // The honest answer to a nag. It records the state either way, and splits the
  // item when — and only when — somebody has written the steps down by hand.
  if (id && action === "stuck") {
    try {
      await recordAction(id, "stuck", true, "marked stuck");
      const n = await splitItem(id);
      return Response.json({ id, stuck: true, split: n });
    } catch {
      return Response.json({ error: "could not record that" }, { status: 500 });
    }
  }

  // --- change a due date ---------------------------------------------------
  if (id) {
    if (dueAt !== null && dueAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) {
      return Response.json({ error: "due date must be YYYY-MM-DD" }, { status: 400 });
    }
    try {
      await setItemDue(id, dueAt || null);
      // "Not this week" is a deferral; dragging the date in the editor is not.
      // Only the one-click answer counts toward the three, because only that one
      // is the tool asking and the owner pushing back.
      if (defer) await recordAction(id, "deferred", true, "not this week");
      return Response.json({ id, dueAt: dueAt || null, deferred: !!defer });
    } catch {
      return Response.json({ error: "could not change that date" }, { status: 500 });
    }
  }

  // --- add an item ---------------------------------------------------------
  if (typeof title !== "string" || !title.trim()) {
    return Response.json({ error: "an item needs a title" }, { status: 400 });
  }
  let due = null;
  if (dueInDays !== null && dueInDays !== undefined && dueInDays !== "") {
    const n = Number(dueInDays);
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      return Response.json({ error: "due-in days must be 0-3650" }, { status: 400 });
    }
    due = daysFromToday(n);
  }
  try {
    return Response.json({ id: await addItem({ title, note, due_at: due }) });
  } catch {
    return Response.json({ error: "could not add that" }, { status: 500 });
  }
}
