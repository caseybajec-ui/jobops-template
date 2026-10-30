/* Password in, signed cookie out.
 *
 * Rate limited per instance. That is genuinely weaker than a shared store —
 * Vercel can run several instances, and each keeps its own counter — but the
 * alternative is a dependency and a second datastore for one user's login page.
 * It raises the cost of a guessing attack by orders of magnitude, which against
 * a URL nobody else knows is the right amount of effort.
 */
import { NextResponse } from "next/server";
import { COOKIE, MAX_AGE_DAYS, sign, timingSafeEqual } from "@/lib/session";

const WINDOW_MS = 15 * 60_000;
const MAX_TRIES = 8;
const tries = new Map();   // ip -> { n, until }

function limited(ip) {
  const now = Date.now();
  const rec = tries.get(ip);
  if (!rec || rec.until < now) {
    tries.set(ip, { n: 1, until: now + WINDOW_MS });
    return false;
  }
  rec.n += 1;
  return rec.n > MAX_TRIES;
}

export async function POST(req) {
  const secret = process.env.JOBOPS_PASSWORD;
  if (!secret) {
    // Refuse rather than letting anyone in. See the middleware comment.
    return NextResponse.json(
      { error: "JOBOPS_PASSWORD is not set on the server" }, { status: 500 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (limited(ip)) {
    return NextResponse.json(
      { error: "Too many attempts. Wait 15 minutes." }, { status: 429 });
  }

  let password = "";
  try {
    ({ password = "" } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Constant-time, and length-padded so the comparison itself does not reveal
  // how long the real password is.
  const a = password.padEnd(Math.max(password.length, secret.length), "\0");
  const b = secret.padEnd(Math.max(password.length, secret.length), "\0");
  if (!timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  tries.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await sign(secret), {
    httpOnly: true,           // JavaScript on the page can never read it
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",  // localhost is not HTTPS
    path: "/",
    maxAge: MAX_AGE_DAYS * 86400,
  });
  return res;
}
