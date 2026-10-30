import { recordWindowCheck } from "@/lib/db";

/**
 * POST /api/windows   { key, closes? }
 *
 * "I checked this window." The optional close date is how the 16 undated
 * windows get dated: one ten-minute check at a time, entered by the person who
 * read the firm's own careers page.
 *
 * Separate from /api/actions because the payload is different — that route takes
 * a boolean and this one takes a date — and because a date needs validating
 * before it can be allowed to change what the page says a deadline is.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { key, closes = null } = body || {};
  if (typeof key !== "string" || !key.startsWith("window:")) {
    return Response.json({ error: "key must be a window key" }, { status: 400 });
  }
  if (closes !== null && closes !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(closes)) {
    return Response.json({ error: "close date must be YYYY-MM-DD" }, { status: 400 });
  }
  // A date must be a real one. `2026-02-31` matches the pattern above and is not
  // a day; letting it through would put a nonsense countdown on the page, which
  // is precisely the failure this whole feature exists to prevent.
  if (closes) {
    const d = new Date(closes + "T00:00:00Z");
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== closes) {
      return Response.json({ error: "that is not a real date" }, { status: 400 });
    }
  }

  try {
    return Response.json(await recordWindowCheck(key, closes || null));
  } catch {
    return Response.json({ error: "could not record that check" }, { status: 500 });
  }
}
