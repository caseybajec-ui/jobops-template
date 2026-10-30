/**
 * THE ONLY PLACE IN THIS REPOSITORY THAT MAY CALL ANTHROPIC.
 *
 * It owns three things that must not be owned anywhere else, because each of
 * them protects something a future session could quietly undo:
 *
 *   the KEY      JOBOPS_ANTHROPIC_KEY, read here and nowhere else
 *   the CAP      30 a calendar month, enforced BEFORE a request is built
 *   the CALL     one fetch to api.anthropic.com, in one function
 *
 * test_ask_isolation.py fails if any other file in the repo reads that variable,
 * names api.anthropic.com, or writes a table from the Ask path. The point is not
 * that today's route behaves — it is that a second endpoint added in six months
 * cannot bypass the cap by calling the API itself, which is exactly the kind of
 * thing that gets added without anyone thinking about a counter.
 *
 * NO FALLBACK. NONE. If JOBOPS_ANTHROPIC_KEY is unset the box renders disabled
 * and names the missing variable. It must never read ANTHROPIC_API_KEY — not as
 * a default, not as a last resort, not "just for local". That key is the general
 * pipeline's and could one day be a different account's, and a fallback is how a
 * personal-account rule becomes a personal-account convention. The absence of a
 * fallback is enforced by a test, because it is one line to add back.
 *
 * WHY THE WEB APP CALLS AN API AT ALL. CLAUDE.md says it must never — a rule
 * about SCORING, which belongs to cron-run Python where spend is predictable.
 * This is the single stated exception: read-only, hard-capped at 30 a month, and
 * the rule in CLAUDE.md now says so rather than being quietly violated.
 *
 * SYNCHRONOUS, WHICH BREAKS "BATCH API ALWAYS". An interactive question cannot
 * wait minutes to hours for a batch. That doubles the per-token price, and at
 * the cap the exception costs about 17c a month — priced, stated, and accepted
 * rather than silently taken.
 */
import { randomUUID } from "node:crypto";
import { ASK_CAP, ASK_MODEL, askCost, logAsk, usedThisMonth,
         countStatusThisMonth } from "./asklog.js";
import { GROK, OWNER } from "./config.generated.js";

// PINNED, and Haiku rather than the Ask model. Reading a log into JSON is
// extraction, not judgement, and CLAUDE.md prefers a dated snapshot over a
// bare alias because an alias can be repointed without notice.
const EXTRACT_MODEL = "claude-haiku-4-5-20251001";

export { ASK_CAP };

const ENV_VAR = "JOBOPS_ANTHROPIC_KEY";
const MAX_OUT = 700;
const MAX_QUESTION = 400;

/**
 * The key, or null. Read in exactly one expression, in exactly one file.
 *
 * READ BY ITS LITERAL NAME, deliberately. The first version was
 * `process.env[ENV_VAR]` with the string held in a constant, on the theory that
 * the literal should appear once — and that made the read INVISIBLE to
 * test_ask_isolation.py, which greps for it. The guard failed with "read in:
 * (nowhere)" and was right to: a read a check cannot see is a read it cannot
 * police, and the indirection bought nothing but a blind spot.
 */
function key() {
  const k = (process.env.JOBOPS_ANTHROPIC_KEY || "").trim();
  return k || null;
}

/** Whether the box can work at all, and if not, exactly why. */
export function askAvailability() {
  return key()
    ? { ready: true, reason: null, envVar: ENV_VAR }
    : { ready: false, envVar: ENV_VAR,
        reason: `${ENV_VAR} is not set. The Ask box is disabled until it is. `
              + "It does not fall back to any other key." };
}

/** What the box shows before you ask anything: how much of the cap is left. */
export async function askStatus(now = new Date()) {
  const a = askAvailability();
  const used = await usedThisMonth(now);
  return {
    ...a,
    used,
    cap: ASK_CAP,
    left: Math.max(0, ASK_CAP - used),
    atCap: used >= ASK_CAP,
  };
}

/**
 * The system prompt. Fixed text — the model is told, in the instruction itself,
 * that it cannot act, because the reader should see the same constraint the
 * architecture enforces.
 */
const SYSTEM = [
  `You answer questions about ${OWNER.name}'s own job-search data, which is`,
  "supplied below. You are read-only: you cannot change anything, take any",
  "action, or run anything. If a question asks you to do something rather than",
  "answer something, say that you can only read.",
  "",
  "Answer from the supplied context alone. If the context does not contain the",
  "answer, say so plainly and say what would — do not guess, and do not fill a",
  "gap with a plausible number. A wrong figure about their own search is worse",
  "than an admission that it is not in front of you.",
  "",
  "Be brief. Three or four sentences unless the question genuinely needs a list.",
  "No preamble, no restating the question.",
].join("\n");

/**
 * Ask one question. The ONLY function in this repository that calls Anthropic.
 *
 * The order matters and is the point: availability, then the CAP, then the
 * request. Nothing reaches the network until the counter has been read and
 * compared — a cap checked after the call is a cap that has already spent the
 * money it exists to prevent.
 */
export async function ask({ question, context, now = new Date() }) {
  const q = String(question || "").trim().slice(0, MAX_QUESTION);
  if (!q) return { ok: false, status: "error", error: "Ask something first." };

  const avail = askAvailability();
  if (!avail.ready) return { ok: false, status: "error", error: avail.reason };

  // THE CAP, BEFORE ANYTHING IS BUILT OR SENT.
  const used = await usedThisMonth(now);
  if (used >= ASK_CAP) {
    await logAsk({
      id: randomUUID(), asked_at: now.toISOString(), question: q,
      model: ASK_MODEL, cost: 0, status: "capped",
    });
    return {
      ok: false, status: "capped",
      error: `${used} of ${ASK_CAP} questions used this month. `
           + "The cap resets on the 1st. Nothing was sent.",
    };
  }

  const body = {
    model: ASK_MODEL,
    max_tokens: MAX_OUT,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `Here is the current state of the search:\n\n${context.text}\n\n`
             + `Question: ${q}`,
    }],
  };

  let res;
  let json;
  try {
    // THE URL IS INLINE, not in a constant. `fetch(ENDPOINT)` is invisible to
    // test_outbound.mjs, which scans for absolute URLs inside fetch() calls —
    // the same blind spot the key read had when it went through a constant. A
    // call a guard cannot see is a call it cannot police.
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    json = await res.json();
  } catch (e) {
    await logAsk({
      id: randomUUID(), asked_at: now.toISOString(), question: q,
      model: ASK_MODEL, ctx_tok: context.tokens, cost: 0, status: "error",
    });
    return { ok: false, status: "error", error: `Could not reach the API: ${e.message}` };
  }

  if (!res.ok) {
    await logAsk({
      id: randomUUID(), asked_at: now.toISOString(), question: q,
      model: ASK_MODEL, ctx_tok: context.tokens, cost: 0, status: "error",
    });
    return {
      ok: false, status: "error",
      error: json?.error?.message || `The API returned ${res.status}.`,
    };
  }

  const usage = json.usage || {};
  const counts = {
    in_tok: usage.input_tokens || 0,
    out_tok: usage.output_tokens || 0,
    cache_r_tok: usage.cache_read_input_tokens || 0,
  };
  const cost = askCost(counts);
  const answer = (json.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("").trim();

  await logAsk({
    id: randomUUID(), asked_at: now.toISOString(), question: q,
    model: json.model || ASK_MODEL, ...counts, cost,
    ctx_tok: context.tokens, status: "ok",
  });

  return {
    ok: true, status: "ok", answer, cost,
    used: used + 1, cap: ASK_CAP, left: Math.max(0, ASK_CAP - used - 1),
  };
}

/* ==========================================================================
 * THE APPLY-LOG FALLBACK
 *
 * WHY IT LIVES IN THIS FILE. CLAUDE.md requires JOBOPS_ANTHROPIC_KEY and
 * api.anthropic.com to appear in exactly ONE file, and says why: "a second
 * endpoint added later cannot bypass the cap by calling the API itself, which
 * is exactly the thing that gets added without anyone thinking about a
 * counter." An extractor in its own module would have been that second
 * endpoint. So it is here, using the same key, the same URL, and the same
 * usedThisMonth() counter, and test_ask_isolation.py still passes unchanged.
 *
 * IT COUNTS AGAINST THE ASK CAP. That is the point rather than a side effect:
 * sharing the counter is what makes a second caller safe. The sub-cap below
 * stops a run of unparseable pastes eating the questions.
 *
 * IT ONLY EVER RUNS WHEN BOTH DETERMINISTIC PARSERS FOUND NOTHING. The route
 * decides that; this function does not check formats and does not know how the
 * paste was read. If it starts firing often, the format has changed and the
 * answer is to fix lib/grok.js rather than to keep paying a model to read
 * around it.
 *
 * IT EXTRACTS AND NOTHING ELSE. It returns rows. It cannot delete a row, it
 * cannot overwrite a deterministic result -- the caller has none, or it would
 * not have asked -- and every row it produces goes through exactly the same
 * matching, dedupe and storage path as a parsed one.
 */

const EXTRACT_MAX_OUT = 2000;
const EXTRACT_MAX_CHARS = 8000;

const EXTRACT_SYSTEM = [
  "You read job-application logs and return JSON. Nothing else.",
  "",
  "Return a JSON array. Each element is one application:",
  '  {"applied_date":"YYYY-MM-DD"|null, "channel":string|null,',
  '   "employer":string, "role":string|null, "location":string|null,',
  '   "status":"success"|"blocked"|"no posting"|"skipped", "notes":string|null}',
  "",
  "Rules:",
  "- employer is REQUIRED. Skip any entry you cannot name an employer for.",
  "- Do NOT invent applications. If the text contains none, return [].",
  "- Do NOT guess a date. Use null and the caller supplies the paste date.",
  "- Do NOT normalise or correct the employer name. Return it as written.",
  "- status defaults to success only when the text says the application was",
  "  submitted. Otherwise use the word the text uses, or null.",
  "- Output the JSON array and nothing else. No prose, no code fence.",
].join("\n");

/** How many extractions this calendar month, for the sub-cap. */
export async function extractsThisMonth(now = new Date()) {
  return countStatusThisMonth("extract", now);
}

/**
 * One Haiku call to read a paste the deterministic parsers could not.
 *
 * Returns { ok, rows, reason }. `rows` is ALWAYS an array -- an empty one on
 * every failure path -- so a caller cannot accidentally treat a refusal as a
 * result.
 */
export async function extractApplications({ text, now = new Date() }) {
  const src = String(text || "").trim().slice(0, EXTRACT_MAX_CHARS);
  if (!src) return { ok: false, rows: [], reason: "nothing to read" };

  const avail = askAvailability();
  if (!avail.ready) return { ok: false, rows: [], reason: avail.reason };

  // BOTH CAPS, BEFORE THE REQUEST IS BUILT. The shared one first, because it
  // is the one that exists for a reason bigger than this feature.
  const used = await usedThisMonth(now);
  if (used >= ASK_CAP) {
    return { ok: false, rows: [],
             reason: `${used} of ${ASK_CAP} model calls used this month. `
                   + "Nothing was sent." };
  }
  const mine = await extractsThisMonth(now);
  if (mine >= GROK.extractMonthlyCap) {
    return { ok: false, rows: [],
             reason: `${mine} of ${GROK.extractMonthlyCap} apply-log `
                   + "extractions used this month. Nothing was sent. If the "
                   + "log needs a model this often, its format has changed "
                   + "and lib/grok.js is what should be fixed." };
  }

  const label = `apply-log extract (${src.length} chars)`;
  let res;
  let json;
  try {
    // THE SAME INLINE URL, in the same file, for the same reason: a call
    // through a constant is invisible to test_outbound.mjs.
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        max_tokens: EXTRACT_MAX_OUT,
        system: EXTRACT_SYSTEM,
        messages: [{ role: "user", content: src }],
      }),
    });
    json = await res.json();
  } catch (e) {
    await logAsk({ id: randomUUID(), asked_at: now.toISOString(),
                   question: label, model: EXTRACT_MODEL, cost: 0,
                   status: "extract" });
    return { ok: false, rows: [], reason: `Could not reach the API: ${e.message}` };
  }

  if (!res.ok) {
    await logAsk({ id: randomUUID(), asked_at: now.toISOString(),
                   question: label, model: EXTRACT_MODEL, cost: 0,
                   status: "extract" });
    return { ok: false, rows: [],
             reason: json?.error?.message || `The API returned ${res.status}.` };
  }

  const usage = json.usage || {};
  const counts = {
    in_tok: usage.input_tokens || 0,
    out_tok: usage.output_tokens || 0,
    cache_r_tok: usage.cache_read_input_tokens || 0,
  };
  // LOGGED BEFORE THE PARSE, so a response that will not parse still counts
  // against both caps. It was sent and it was billed; letting an unparseable
  // answer be free is how "retry until it works" becomes a way around a cap.
  await logAsk({ id: randomUUID(), asked_at: now.toISOString(),
                 question: label, model: json.model || EXTRACT_MODEL,
                 ...counts, cost: askCost(counts), status: "extract" });

  const out = (json.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return { ok: true, rows: parseExtracted(out),
           reason: null, used: used + 1, mine: mine + 1 };
}

/**
 * The model's JSON, read defensively.
 *
 * IT HONOURS "ONLY JSON" ABOUT HALF THE TIME -- measured on this model in this
 * project, which is why score_jobs pulls the first balanced block out rather
 * than calling JSON.parse on the whole response. Same here: find the array,
 * parse it, and drop anything that is not a usable row.
 *
 * A ROW WITHOUT AN EMPLOYER IS DROPPED, not defaulted. There is nothing
 * honest to put there, and an application filed against "" is worse than one
 * that was never recorded.
 */
export function parseExtracted(textOut) {
  const s = String(textOut || "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((r) => r && typeof r === "object" && String(r.employer || "").trim())
    .map((r) => ({
      applied_date: typeof r.applied_date === "string" ? r.applied_date : null,
      channel: typeof r.channel === "string" ? r.channel : null,
      employer_raw: String(r.employer).trim(),
      role: typeof r.role === "string" && r.role.trim() ? r.role.trim() : null,
      location: typeof r.location === "string" ? r.location : null,
      status: typeof r.status === "string" && r.status.trim()
        ? r.status.trim().toLowerCase() : "success",
      notes: typeof r.notes === "string" ? r.notes : null,
    }));
}
