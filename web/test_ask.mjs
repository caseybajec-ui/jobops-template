/**
 * The Ask box's arithmetic and its context budget. Run: node test_ask.mjs
 *
 * The fence around the feature — one key, one endpoint, one writable table, the
 * cap before the request — is test_ask_isolation.py, which is structural. These
 * are the parts that are pure: what a query costs, and how much of the search
 * gets sent.
 */
import { ASK_CAP, ASK_MODEL, askCost } from "./lib/askprice.js";
import { CTX_BUDGET_TOKENS, buildContext, estimateTokens } from "./lib/askcontext.js";

let pass = 0;
const fails = [];
const ok = (c, what) => (c ? pass++ : fails.push(what));
const near = (a, b, what, eps = 1e-9) =>
  ok(Math.abs(a - b) < eps, `${what}: got ${a}, want ${b}`);

/* ------------------------------------------------------------- the price */

ok(ASK_CAP === 30, "the cap is thirty a month");
ok(ASK_MODEL === "claude-haiku-4-5", "one model, and it is Haiku");

// $1/Mtok in, $5/Mtok out — the same rate card as lib/cost.js and PRICES in
// score_jobs.py. Two rate cards is how you get two answers to "what have I spent".
near(askCost({ in_tok: 1e6, out_tok: 0 }), 1.0, "a million input tokens is $1");
near(askCost({ in_tok: 0, out_tok: 1e6 }), 5.0, "a million output tokens is $5");
near(askCost({ in_tok: 0, out_tok: 0, cache_r_tok: 1e6 }), 0.1,
     "a cache read is a tenth of the input rate");
near(askCost({}), 0, "nothing costs nothing");

// NO BATCH DISCOUNT. Every other priced row in this app went through the Batch
// API and is halved; an interactive question cannot be. Halving these would
// under-report by exactly the factor the meter has already been wrong by.
near(askCost({ in_tok: 8000, out_tok: 700 }), 0.008 + 0.0035,
     "a worst-case question is about 1.15 cents, undiscounted");

// The whole month at the cap, which is the number the decision was made on.
{
  const worst = askCost({ in_tok: 8000, out_tok: 700 }) * ASK_CAP;
  ok(worst > 0.30 && worst < 0.40, `a full month at the cap is ~35c (got ${worst.toFixed(3)})`);
}

/* ----------------------------------------------------------- the estimate */

ok(estimateTokens("") === 0, "an empty string is no tokens");
ok(estimateTokens("x".repeat(360)) === 100, "about 3.6 characters a token");
// HIGH ON PURPOSE. This decides how much to send, so over-estimating spends
// less than under-estimating, and the alternative is a count_tokens round trip
// before every question to save nothing.
ok(estimateTokens("the quick brown fox jumps over the lazy dog") >= 10,
   "and it errs high rather than low");

/* ------------------------------------------------------------ the context */

const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const BIG = {
  today: "2026-09-02", graduation: "May 2031",
  counts: { openRoles: 9840, reachable: 736 },
  windows: many(25, (i) => ({ firm: `Firm${i}`, program: "Analyst, undergraduate",
                              closes: null, closeIn: null,
                              confidence: "historical-estimate", status: "open" })),
  items: many(8, (i) => ({ title: `Task ${i}`, dueIn: i - 3, done: false })),
  contacts: many(12, (i) => ({ name: `Person ${i}`, company: "palantir",
                               status: "waiting", last: "messaged 4d ago" })),
  applications: many(5, (i) => ({ company: `Co${i}`, title: `Role ${i}`,
                                  status: "applied", days: i })),
  sf86: { pct: 75, per: { contact: { pct: 20, rows: 1 } } },
  roles: many(40, (i) => ({ company: `Company${i}`, title: `A role title ${i}`,
                            band: "Strong", location: "San Francisco, CA",
                            pay: "$130-150K", start: "2031" })),
};

{
  const c = buildContext(BIG);
  ok(c.tokens <= CTX_BUDGET_TOKENS, `a realistic slice fits the budget (${c.tokens})`);
  ok(c.dropped.length === 0, "and nothing is dropped at 40 roles");
  ok(/## Application windows/.test(c.text), "windows are in it");
  ok(/## Roles that fit/.test(c.text), "so are the roles");
  ok(/2026-09-02/.test(c.text), "and today's date, which questions are relative to");
}

// NEVER THE WHOLE CORPUS. 9,800 postings would cost more per question than the
// entire monthly cap, so an over-large section is dropped whole.
{
  const c = buildContext({ ...BIG, roles: many(400, (i) => ({
    company: `Company${i}`, title: `A fairly long role title here ${i}`,
    band: "Strong", location: "San Francisco, California, United States",
    pay: "$130-150K", start: "2031" })) });
  ok(c.tokens <= CTX_BUDGET_TOKENS, `400 roles still fits the budget (${c.tokens})`);
  ok(c.dropped.length > 0, "because the roles section is dropped");
  // SAID, NOT SILENT. A model handed a truncated context with no note answers as
  // though it had the whole thing — which is how you get a confident sentence
  // about three companies when there were forty.
  ok(/## Not included/.test(c.text), "and the context SAYS what was left out");
  ok(c.text.includes(c.dropped[0]), "naming the section by name");
}

// DROPPED WHOLE, NEVER CUT IN HALF. A table truncated mid-row reads like a
// complete table.
{
  const c = buildContext({ ...BIG, roles: many(400, (i) => ({
    company: `C${i}`, title: `T${i}`, band: "Strong",
    location: "San Francisco", pay: "$1", start: "2031" })) });
  const lines = c.text.split("\n").filter((l) => l.includes(" | "));
  ok(lines.every((l) => !l.endsWith(" |")), "no row is cut off mid-way");
}

{
  const c = buildContext({});
  ok(c.text.length > 0, "an empty state still produces a context");
  ok(c.tokens > 0 && c.tokens < 200, "a small one");
}

console.log(`${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFAILURES:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
