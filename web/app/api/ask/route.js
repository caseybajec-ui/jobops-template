import { NextResponse } from "next/server";
import { ask, askStatus } from "@/lib/ask";
import { buildContext } from "@/lib/askcontext";
import {
  curatedJobs, bandCounts, entryCounts, windowChecks, listItems,
} from "@/lib/db";
import { getDeadlines, applyChecks } from "@/lib/deadlines";
import { getPeople, getSf86, getSf86Affirmations } from "@/lib/contacts";
import { listActiveApplications } from "@/lib/applications";
import { completeness } from "@/lib/sf86";
// Aliased to todayLocal, matching Daily.js, Items.js and contacts.js — NOT to
// todayIn. lib/scheduler.js and lib/availability.js both export a todayIn whose
// FIRST argument is the timezone, while day.js's today() takes (now, tz). The
// old `today as todayIn` alias made this file read like those two, and the call
// below was written to their signature: the tz string landed in `now`, so every
// question 500'd on `now.toLocaleDateString is not a function`.
import { today as todayLocal } from "@/lib/day";
import { GRADUATION } from "@/lib/config.generated.js";

export const dynamic = "force-dynamic";

/**
 * "Ask about this data" — one question, one answer, no memory.
 *
 * EVERY READ IN THIS FILE IS A SELECT. There is no write anywhere in this route:
 * the only write the feature performs is the cost log, which lives in
 * lib/asklog.js and can INSERT into exactly one table. test_ask_isolation.py
 * fails if that stops being true, and it walks the imports rather than trusting
 * the claim.
 *
 * SINGLE TURN, NOTHING STORED. No conversation history is kept — not in the
 * database, not in a session, not in the page. Each question is answered from
 * the context assembled for it and nothing else, which is what makes "what did
 * it see" a question with an exact answer: the route returns the context it
 * built, and the box shows it.
 *
 * The bounded slices below are the point of the whole design. 40 roles, not
 * 9,800: buildContext would drop an over-large section rather than truncate it,
 * but relying on the safety net to do the budgeting would mean the roles are the
 * thing that always vanishes. They are chosen here, deliberately, best first.
 */
const ROLE_LIMIT = 40;
const CONTACT_LIMIT = 40;

export async function GET() {
  // What the box shows before anything is asked: whether it can run at all, and
  // how much of the cap is left.
  return NextResponse.json(await askStatus());
}

/**
 * ANY unexpected throw becomes JSON. Without this the route answered a bare 500
 * with an EMPTY BODY, the page's `res.json()` threw on it, and the box displayed
 * "Failed to execute 'json' on 'Response': Unexpected end of JSON input" — a
 * browser error about parsing, shown where the reason belongs. The real fault
 * (a TypeError in buildContext) was visible only in the server log.
 *
 * The message does not claim nothing was sent. A throw before ask() costs
 * nothing, a throw after it has already been billed and counted, and the route
 * cannot tell the reader which from here — so it points at the counter, which
 * is COUNT(*) over ask_queries and therefore right either way.
 */
export async function POST(req) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("ask route failed:", e);
    return NextResponse.json(
      { error: "The Ask box hit an unexpected error. Check the counter above: "
             + "if it moved, the question was sent and charged; if it did not, "
             + "nothing was spent. The server log has the cause." },
      { status: 500 },
    );
  }
}

async function handle(req) {
  let question = "";
  try {
    ({ question } = await req.json());
  } catch {
    return NextResponse.json({ error: "Send a question." }, { status: 400 });
  }
  if (typeof question !== "string" || !question.trim()) {
    return NextResponse.json({ error: "Ask something first." }, { status: 400 });
  }

  // Refuse BEFORE reading anything at all. At the cap there is no reason to
  // touch the database, and a refusal that still did the work would be a cap
  // that only saves the API call.
  const status = await askStatus();
  if (!status.ready) {
    return NextResponse.json({ error: status.reason, ready: false }, { status: 503 });
  }
  if (status.atCap) {
    const r = await ask({ question, context: { text: "", tokens: 0 } });
    return NextResponse.json({ error: r.error, atCap: true, ...status }, { status: 429 });
  }

  const [roles, bands, entry, checks, items, people, apps, sf86, affirmations] = await Promise.all([
    curatedJobs({ limit: ROLE_LIMIT, cap: 2 }).catch(() => []),
    bandCounts().catch(() => ({})),
    entryCounts().catch(() => ({})),
    windowChecks().catch(() => []),
    listItems().catch(() => []),
    // getPeople() resolves to { people, ready }, NOT an array — every other
    // caller destructures it. Unwrapped here so the failure shape and the
    // success shape are the same thing, which is what hid the mismatch: the
    // catch returned [] and looked exactly like what the route expected.
    getPeople().then((r) => r?.people ?? []).catch(() => []),
    listActiveApplications().catch(() => []),
    getSf86().catch(() => ({ ready: false, rows: [] })),
    getSf86Affirmations().catch(() => ({})),
  ]);

  const windows = applyChecks(getDeadlines(), checks);
  const context = buildContext({
    today: todayLocal(),           // (now = new Date(), tz = USER_TZ) — both defaulted
    graduation: GRADUATION,
    counts: { openRoles: entry?.total ?? null, reachable: bands?.total ?? null },
    windows: windows.map((w) => ({
      firm: w.firm, program: w.program, closes: w.closes,
      closeIn: w.closeIn, confidence: w.confidence, status: w.status,
    })),
    items: items.filter((i) => !i.done).map((i) => ({
      title: i.title, dueIn: i.dueIn, done: i.done,
    })),
    contacts: people.slice(0, CONTACT_LIMIT).map((p) => ({
      name: p.name, company: p.company, status: p.status,
      last: p.lastWhat || null,
    })),
    applications: apps.map((a) => ({
      company: a.display_name || a.company, title: a.title,
      status: a.status, days: a.daysInStage,
    })),
    // AFFIRMATIONS ARE THE THIRD ARGUMENT AND WERE BEING DROPPED. Without
    // them "none, said out loud" scores 0 rather than complete, so the Ask
    // box was told a section was unfinished that the owner had answered. The
    // page passed all three; this call site did not, and a data-layer test
    // could never see the difference — completeness() itself was correct.
    sf86: sf86?.ready ? completeness(sf86.rows, new Date(), affirmations) : null,
    roles: roles.map((r) => ({
      company: r.display_name || r.company, title: r.displayTitle || r.title,
      band: r.band, location: r.locationLabel || r.location,
      pay: r.comp, start: r.start_window,
    })),
  });

  const result = await ask({ question, context });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.status === "capped" ? { atCap: true } : {}) },
      { status: result.status === "capped" ? 429 : 502 },
    );
  }

  return NextResponse.json({
    answer: result.answer,
    cost: result.cost,
    used: result.used,
    cap: result.cap,
    left: result.left,
    // WHAT IT READ, returned so the page can show it. An answer you cannot
    // check the inputs of is an answer you either trust blindly or stop using.
    context: {
      text: context.text,
      tokens: context.tokens,
      sections: context.sections,
      dropped: context.dropped,
    },
  });
}
