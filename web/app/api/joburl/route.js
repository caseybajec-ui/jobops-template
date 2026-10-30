import { setJobUrl } from "@/lib/db";

/**
 * POST /api/joburl   { key, url }
 *
 * The one field on a job row the app may write, and only on a MANUAL row.
 *
 * The refusal lives in setJobUrl rather than here, and this route only reports
 * it. A validation that lives in the route is one a future caller skips without
 * noticing — the same reasoning /api/profile records for rejectWrite.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const { key, url } = body || {};
  if (typeof key !== "string" || !key) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }
  if (typeof url !== "string") {
    return Response.json({ error: "url must be a string" }, { status: 400 });
  }
  if (url.length > 1000) {
    return Response.json({ error: "that is longer than any posting URL" },
                         { status: 400 });
  }
  try {
    return Response.json(await setJobUrl(key, url));
  } catch (e) {
    // The message is the point: "only a manually added role's URL can be
    // edited" tells you why the control did nothing, where a bare 500 would
    // look like the save silently failing.
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
