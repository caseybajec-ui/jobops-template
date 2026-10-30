import { recordAction } from "@/lib/db";
import { HIDE_REASON_KEYS } from "@/lib/display";

/**
 * POST /api/actions   { key, kind, on }
 *
 * The only way the browser writes an action. POST only, validated here, and the
 * write itself goes through lib/db.js — no component and no client ever touches
 * the database.
 *
 * Returns the state that was actually recorded so the client can reconcile its
 * optimistic update against what happened, rather than assume it worked.
 */
const KINDS = ["save", "hide", "applied", "target", "done"];

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { key, kind, on = true, note = null } = body || {};
  if (typeof key !== "string" || !key.trim()) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }
  if (!KINDS.includes(kind)) {
    return Response.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  }
  if (typeof on !== "boolean") {
    return Response.json({ error: "on must be a boolean" }, { status: 400 });
  }

  // A hide reason must come from the closed list, or the column is free text
  // wearing a schema and nothing can be counted from it later.
  if (kind === "hide" && on && note !== null && !HIDE_REASON_KEYS.includes(note)) {
    return Response.json(
      { error: `reason must be one of ${HIDE_REASON_KEYS.join(", ")}` }, { status: 400 });
  }

  try {
    return Response.json(await recordAction(key.trim(), kind, on, note));
  } catch (e) {
    // The message is ours, not the driver's — never leak a query or a path.
    return Response.json({ error: "could not save that" }, { status: 500 });
  }
}
