import { today as todayIn } from "@/lib/day";
import { importApplyLog } from "@/lib/importlog";

/**
 * POST /api/applications/import — an apply bot pushing its own log.
 *
 *   Authorization: Bearer <JOBOPS_IMPORT_TOKEN>
 *   { "text": "<the apply log, same two formats the paste box accepts>" }
 *
 * WHY THIS EXISTS. The first integration between the apply bot and this app
 * was the bot signing in through a browser WITH THE OWNER'S PASSWORD, pasting
 * into the box, and reading the table back. That handed a reusable secret to
 * a process that writes memory files, and it broke silently every thirty days
 * when the session cookie expired ("JobOps PENDING sign-in", for weeks). A
 * token that unlocks exactly one write is the smaller thing to hand over.
 *
 * WHAT A STOLEN TOKEN BUYS: rows in applied_apps, deduped by employer and
 * role, capped per request, every import recorded in applied_imports with
 * the raw text on failure. It cannot read anything, create a contact, draft
 * a message, or touch any other table. Rotate it in Vercel and the old one
 * is dead on the next request.
 *
 * NO MODEL FALLBACK HERE. The paste box may spend one capped Haiku call to
 * read a paste that parsed to nothing, because a human is watching the red
 * banner. A bot is not, and a bot that keeps pushing an unparseable format
 * would spend the whole sub-cap on it by lunchtime. It gets the deterministic
 * parser and the honest "nothing parsed" answer, which is what should make
 * it fix its format.
 *
 * ONE SHOT ANSWER. The response carries stored/updated/unmatched and, when
 * the header line's column order disagrees with the positional order the
 * rows are read in, a warning -- the bot's instructions say to read it and
 * re-check the rows rather than trust the counts.
 */
export const dynamic = "force-dynamic";

const TOKEN = process.env.JOBOPS_IMPORT_TOKEN;

/** Constant-time compare, so the response time does not leak the prefix. */
function tokenOk(header) {
  const given = String(header || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || !given || given.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) {
    diff |= TOKEN.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

const deny = () => Response.json({ error: "unauthorized" }, { status: 401 });

export async function POST(req) {
  if (!tokenOk(req.headers.get("authorization"))) return deny();
  const body = await req.json().catch(() => ({}));
  const { status, body: out } = await importApplyLog({
    text: body.text, today: todayIn(), source: "bot_api",
    // Deliberately no extractor: see the header comment.
    extract: null,
  });
  return Response.json(out, { status });
}

/** A bot checking its token and the format without writing anything. */
export async function GET(req) {
  if (!tokenOk(req.headers.get("authorization"))) return deny();
  return Response.json({
    ok: true,
    format: "date | channel | employer | role | location | status | notes",
    statuses: ["success", "blocked", "no posting", "skipped", "rejected", "parked"],
    note: "POST {text} with one pipe-delimited line per application. Rows are "
      + "read by position; a header line is skipped. Re-posting the same rows "
      + "updates them. Read the response's unmatched[] and warning fields.",
  });
}
