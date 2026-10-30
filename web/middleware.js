/* One gate in front of everything.
 *
 * Vercel's own Password Protection is Pro-only, and Deployment Protection does
 * not cover a production deployment on the Hobby plan — so on the free tier the
 * choice is this or nothing at all. See HOSTING.md.
 *
 * Deny by default: the matcher covers every path, and the allow-list below is
 * the login page, the login API, and Next's own static assets. Anything added to
 * the app later is protected without anyone remembering to protect it, which is
 * the only arrangement that survives new pages being added.
 *
 * If JOBOPS_PASSWORD is unset the site is CLOSED, not open. An unset secret is a
 * misconfiguration, and the safe reading of a misconfigured lock is "locked".
 */
import { NextResponse } from "next/server";
import { COOKIE, verify } from "@/lib/session";

export const config = {
  // Everything except Next's build output and the favicon. Note that /api IS
  // matched: the pages are useless without their data, so leaving the API open
  // would leave the data open.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

const OPEN = new Set(["/login", "/api/login"]);

/** Pass the path down so the root layout can tell the gate from the app. */
function withPath(req) {
  const h = new Headers(req.headers);
  h.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: h } });
}

export async function middleware(req) {
  const { pathname } = req.nextUrl;
  if (OPEN.has(pathname)) return withPath(req);

  // BEARER-TOKEN ROUTES, enumerated one by one, and nothing else a token could
  // unlock.
  //
  // Two callers have no cookie and no browser: the local LinkedIn reader on the
  // owner's PC (JOBOPS_LOCAL_TOKEN), and an external apply bot pushing its log
  // (JOBOPS_IMPORT_TOKEN). Each gets EXACTLY the paths it needs, the token must
  // be configured, and every route re-checks its token in constant time --
  // middleware waving a request through is not the same as the route trusting
  // it.
  //
  // THIS WAS A PREFIX MATCH AND THAT WAS A HOLE. `startsWith("/api/suggested")`
  // also covered /api/suggested/act, which promotes a suggestion into a real
  // contact and checks neither token nor session: any request carrying any
  // `Authorization: Bearer` header could create contacts. An allow-list of
  // exact paths cannot grow by accident when a sibling route is added.
  //
  // WHAT A STOLEN TOKEN BUYS is the whole reason this is acceptable: the
  // reader's routes write suggestions and read five target companies; the
  // import route writes apply-log rows. Neither can create a contact, an
  // outreach row, or a draft.
  const bearer = (req.headers.get("authorization") || "").startsWith("Bearer ");
  if (bearer && process.env.JOBOPS_LOCAL_TOKEN
      && (pathname === "/api/suggested" || pathname === "/api/suggested/targets")) {
    return withPath(req);
  }
  if (bearer && process.env.JOBOPS_IMPORT_TOKEN
      && pathname === "/api/applications/import") {
    return withPath(req);
  }

  const ok = await verify(process.env.JOBOPS_PASSWORD,
                          req.cookies.get(COOKIE)?.value);
  if (ok) return withPath(req);

  // An unauthenticated API call gets a 401, not a redirect to an HTML page —
  // a fetch() following a redirect and parsing a login form as JSON is a
  // confusing way to discover the session expired.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const to = req.nextUrl.clone();
  to.pathname = "/login";
  to.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(to);
}
