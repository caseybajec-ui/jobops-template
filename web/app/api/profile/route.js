import { setProfileField } from "@/lib/contacts";
import { rejectWrite } from "@/lib/card";

/**
 * POST /api/profile   { key, value }
 *
 * One field at a time, because the card autosaves on blur and a whole-object
 * write would mean every blur racing every other blur for the same row.
 *
 * The rule check runs HERE and again inside setProfileField. That is deliberate
 * duplication: this route returns a readable message to the browser, and the
 * data layer refuses regardless of who calls it. A validation that lives only
 * in the route is one a future CLI skips without noticing.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { key, value } = body || {};
  if (typeof key !== "string") {
    return Response.json({ error: "key is required" }, { status: 400 });
  }
  if (typeof value !== "string") {
    return Response.json({ error: "value must be a string" }, { status: 400 });
  }
  if (value.length > 2000) {
    return Response.json({ error: "that is longer than any form field accepts" },
                         { status: 400 });
  }

  const err = rejectWrite(key, value);
  if (err) return Response.json({ error: err }, { status: 400 });

  try {
    return Response.json(await setProfileField(key, value.trim()));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
