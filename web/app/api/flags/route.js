import { setRoleFlag } from "@/lib/db";
import { FLAG_WRONG_CYCLE } from "@/lib/actions";

/**
 * POST /api/flags   { scope, key, on, note }
 *
 * "This role is for the wrong graduating cycle — stop showing it to me."
 *
 * Separate from /api/actions on purpose, even though both write an insert-only
 * row against a group key. Hiding is a preference about one list; a wrong-cycle
 * flag is a statement about the world that removes the role from every surface
 * in the app, and the two are undone in different places by different gestures.
 * Folding them into one endpoint would mean one `kind` string standing between
 * "not for me today" and "not for me, ever, anywhere".
 */
const SCOPES = ["role", "company"];
const FLAGS = [FLAG_WRONG_CYCLE];

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { scope, key, on = true, note = null, flag = FLAG_WRONG_CYCLE } = body || {};
  if (!SCOPES.includes(scope)) {
    return Response.json({ error: `scope must be one of ${SCOPES.join(", ")}` }, { status: 400 });
  }
  if (typeof key !== "string" || !key.trim()) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }
  if (!FLAGS.includes(flag)) {
    return Response.json({ error: `flag must be one of ${FLAGS.join(", ")}` }, { status: 400 });
  }
  if (typeof on !== "boolean") {
    return Response.json({ error: "on must be a boolean" }, { status: 400 });
  }
  // Free text, unlike a hide reason, and deliberately: the closed list exists so
  // hides can be counted, and there is nothing to count here. What matters is
  // that the sentence is readable a year later in the undo list — "their
  // analyst class targets December graduates" is the whole value of the row.
  if (note !== null && (typeof note !== "string" || note.length > 400)) {
    return Response.json({ error: "note must be a string under 400 characters" },
                         { status: 400 });
  }

  try {
    return Response.json(await setRoleFlag(scope, key.trim(), on, note, flag));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
