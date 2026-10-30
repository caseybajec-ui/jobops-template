import { recordRoleEvent } from "@/lib/db";
import { LIFECYCLE_KEYS } from "@/lib/lifecycle";

/**
 * POST /api/lifecycle   { key, status, referral?, note? }
 *
 * Where a role got to. Insert-only through lib/db.js — no component and no
 * client ever touches the database.
 *
 * Separate from /api/actions because the payloads are different shapes: that
 * one takes a boolean and a closed reason list, this one takes a stage and an
 * optional tri-state. Folding them together would mean one handler validating
 * two grammars, which is how a bad value gets through.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { key, status, referral = null, note = null } = body || {};
  if (typeof key !== "string" || !key.trim()) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }
  if (!LIFECYCLE_KEYS.includes(status)) {
    return Response.json(
      { error: `status must be one of ${LIFECYCLE_KEYS.join(", ")}` }, { status: 400 });
  }
  // TRI-STATE, and null is a real answer meaning "not asked". Coercing an
  // absent answer to false would invent evidence against the referral thesis,
  // which is the one thing this column exists to test.
  if (referral !== null && typeof referral !== "boolean") {
    return Response.json(
      { error: "referral must be true, false, or omitted" }, { status: 400 });
  }

  try {
    return Response.json(await recordRoleEvent(key.trim(), status, { referral, note }));
  } catch {
    // Ours, not the driver's — never leak a query or a path.
    return Response.json({ error: "could not record that" }, { status: 500 });
  }
}
