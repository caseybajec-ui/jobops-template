import { setHoursToday, clearHoursToday } from "@/lib/db";

/**
 * POST /api/hours   { day, hours }
 *
 * `hours: 0` clears the answer rather than storing a zero-hour day. Storing 0
 * would trim the ladder to its first item forever and read as "I have no time,
 * ever" — which is a different claim from "I did not answer", and the ladder
 * treats those two very differently.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { day, hours } = body || {};
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
  }
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0 || h > 24) {
    return Response.json({ error: "hours must be between 0 and 24" }, { status: 400 });
  }

  try {
    return Response.json(h === 0 ? await clearHoursToday(day) : await setHoursToday(day, h));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
