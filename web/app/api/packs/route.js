import { markPackUsed } from "@/lib/db";

/**
 * POST /api/packs   { key }
 *
 * "the owner copied something out of this pack."
 *
 * IT RECORDS HIS ACTION, NOT THE TOOL'S. Nothing here sends anything, and there
 * is no field on this route that could name a recipient. The same shape as the
 * outreach copy log: the clipboard write happens in the browser first, and this
 * only records that it did.
 *
 * FIRST TOUCH ONLY, enforced in the UPDATE rather than here — `used_at` answers
 * "has he ever worked from this pack", and a second copy moving it would turn
 * the column into "last touched", which is a different question and would make
 * the untouched count wrong.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const key = body?.key;
  if (typeof key !== "string" || !key.trim()) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }

  try {
    await markPackUsed(key.trim());
    return Response.json({ ok: true });
  } catch (e) {
    // THE COPY ALREADY HAPPENED. Failing loudly here would tell the owner the copy
    // failed when the text is on his clipboard, so this reports the write
    // failure honestly and separately rather than as a failed copy.
    return Response.json(
      { error: `copied, but the use could not be recorded: ${e.message}` },
      { status: 500 });
  }
}
