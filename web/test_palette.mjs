/**
 * The colour system, checked. Run: node test_palette.mjs
 *
 * Two halves, and the first is the one that will actually catch something.
 *
 * 1. CONTRAST IS RECOMPUTED FROM tokens.css, not asserted from memory. Every
 *    value in that file was measured once, at 2026-08-30, and a hex code is the
 *    easiest thing in a stylesheet to nudge — "a bit brighter" is one character
 *    and it is invisible in a diff whether the result still passes AA. So this
 *    parses the token file, does the WCAG maths, and fails on the ones that
 *    stopped passing. It is not a snapshot of the numbers: it is the rule.
 *
 * 2. THE MAPPINGS ARE PURE, so they are tested without a browser or a database:
 *    which class a score gets, which level a day count gets, and — the one that
 *    matters most — that the four company categories are the four in the
 *    palette and no fifth has crept in. A fifth category means a fifth colour,
 *    and there are four.
 *
 * It also runs a POSITIVE CONTROL at the end: a deliberately unreadable colour
 * is pushed through the same checker and the checker must reject it. A contrast
 * test that has only ever passed is indistinguishable from one that cannot fail
 * — the same argument as the 331-character control in test_overflow.mjs.
 */
import fs from "node:fs";
import {
  bandClass, urgencyLevel, urgencyClass, evidenceClass, provenanceClass,
  categoryClass, categoryOfCompany, categoryOfFirm, CATEGORIES,
  progressOf, windowProgress, trackableWindows,
  URGENCY_NOW_DAYS, URGENCY_SOON_DAYS,
} from "./lib/palette.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));

/* ------------------------------------------------------------- WCAG maths */

const channels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const linear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (h) => {
  const [r, g, b] = channels(h).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ---------------------------------------------------------- read the tokens */

const css = fs.readFileSync("app/tokens.css", "utf8");
const token = {};
for (const m of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
  token[m[1]] = m[2].toLowerCase();
}
// A parser that matched nothing would pass every check below in silence.
ok(Object.keys(token).length >= 20,
   `tokens.css parsed to ${Object.keys(token).length} colours, expected 20+ — the parser matched almost nothing`);

// The two grounds a token can land on. Rows swap to --card on hover, so a colour
// that passes on paper and fails on card is a colour that fades when you point
// at it — which is exactly when you are reading it.
const PAPER = "#edeff2";
const CARD = "#f7f8fa";

/**
 * Read as TEXT: must clear 4.5:1 on both grounds.
 * Every band word, every urgency count, every chip label.
 */
const TEXT = [
  "--band-excellent", "--band-strong", "--band-good", "--band-fair", "--band-weak",
  "--u-now", "--u-soon", "--u-later",
  "--v-strong", "--v-weak", "--v-none",
];

/**
 * Read as a GRAPHIC: 3:1 is the WCAG bar for a non-text object.
 *
 * The category dots are here rather than in TEXT because a 7px dot is not text
 * — and every one of them clears 4.5 anyway, so the looser bar is not doing any
 * work for them today. It is stated as 3 because that is the honest requirement
 * for the shape, not because the values need the room.
 */
const DOTS = ["--cat-defense", "--cat-product", "--cat-consulting", "--cat-vc"];

/**
 * Bar fills, measured against the TRACK they sit in rather than against the
 * page, because that is the edge a reader has to see.
 *
 * --band-fair-fill and --band-weak-fill are deliberately absent. They are the
 * pre-existing grey pair (--bar on --bar-bg) and they do not clear 3:1 against
 * each other; that is accepted because the band WORD is on every row beside the
 * bar and carries the same fact in text. Nothing in this app depends on telling
 * a grey bar from its track.
 */
const FILLS = ["--band-excellent-fill", "--band-strong-fill", "--band-good-fill",
               "--p-done"];

for (const t of TEXT) {
  const c = token[t];
  ok(c, `${t} is missing from tokens.css`);
  if (!c) continue;
  const onPaper = contrast(c, PAPER);
  const onCard = contrast(c, CARD);
  ok(onPaper >= 4.5, `${t} ${c} is ${onPaper.toFixed(2)}:1 on the page ground — AA text needs 4.5`);
  ok(onCard >= 4.5, `${t} ${c} is ${onCard.toFixed(2)}:1 on a hovered row — AA text needs 4.5`);
}

for (const t of DOTS) {
  const c = token[t];
  ok(c, `${t} is missing from tokens.css`);
  if (!c) continue;
  const r = contrast(c, PAPER);
  ok(r >= 3, `${t} ${c} is ${r.toFixed(2)}:1 on the page ground — a graphic needs 3`);
}

for (const t of FILLS) {
  const c = token[t];
  ok(c, `${t} is missing from tokens.css`);
  if (!c) continue;
  const r = contrast(c, token["--p-track"]);
  ok(r >= 3, `${t} ${c} is ${r.toFixed(2)}:1 against the bar track — a graphic needs 3`);
}

/**
 * The progress meter is now a fill on a track, so it is checked the same way a
 * band bar is — and --p-done is in FILLS above for exactly that reason.
 *
 * WHAT IS ASSERTED HERE INSTEAD: that the amber second segment is GONE. It was
 * --p-todo, and it made an empty bar a solid amber block: People's "0 of 5
 * messages" read at a glance as a full alert rather than an untouched counter,
 * which is the opposite of the fact. It also spent the urgency amber — "closes
 * in 8-30 days" everywhere else — on an unrelated second meaning.
 *
 * A deleted token is the kind of thing that comes back, because "the not-yet
 * half should be visible" is a reasonable-sounding argument right up until you
 * look at a bar at zero. So the test names it.
 */
{
  ok(!token["--p-todo"],
     "--p-todo is back in tokens.css — the meter's remainder is the TRACK, not a colour; an amber remainder makes an empty bar read as a full alert");
  const onTrack = contrast(token["--p-done"], token["--p-track"]);
  ok(onTrack >= 3,
     `the meter's fill is ${onTrack.toFixed(2)}:1 against its track — a graphic needs 3, and this edge is now the only one on the bar`);
  // The track has to be visible against the PAGE too, or the bar's total length
  // — the denominator — cannot be read at all. A large solid block, not text,
  // so the bar is well under 4.5; low enough to catch it drifting to invisible.
  const onPaper = contrast(token["--p-track"], PAPER);
  ok(onPaper >= 1.1,
     `the bar track is ${onPaper.toFixed(2)}:1 against the page — the bar's full length would be invisible`);
}

/**
 * The four category hues must be distinguishable FROM EACH OTHER — and that is
 * a question about HUE, not about contrast.
 *
 * This was written as a pairwise WCAG contrast check and every pair failed at
 * around 1.1:1. The colours were fine; the assertion was wrong. Contrast
 * measures relative LUMINANCE, and four dots deliberately chosen at similar
 * lightness — so that no category shouts louder than the others — are guaranteed
 * to score near 1.0 against each other no matter how different they look. A test
 * that fails on correct values teaches you to delete the test.
 *
 * Angular hue distance is the property actually being relied on. 45 degrees is
 * roughly the point at which two swatches of equal lightness stop being
 * confusable side by side; the closest pair here sits at 58.
 */
const hueOf = (hex) => {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6
          : max === g ? (b - r) / d + 2
          : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};
const apart = (a, b) => {
  const d = Math.abs(hueOf(a) - hueOf(b)) % 360;
  return d > 180 ? 360 - d : d;
};
for (let i = 0; i < DOTS.length; i++) {
  for (let j = i + 1; j < DOTS.length; j++) {
    const d = apart(token[DOTS[i]], token[DOTS[j]]);
    ok(d >= 45,
       `${DOTS[i]} and ${DOTS[j]} are only ${d.toFixed(0)} degrees of hue apart — too close to tell one dot from the other`);
  }
}

/* ----------------------------------------------------------- the mappings */

ok(bandClass(92) === "b-excellent", "92 is Excellent");
ok(bandClass(85) === "b-excellent", "85 is the bottom of Excellent");
ok(bandClass(84) === "b-strong", "84 falls to Strong");
ok(bandClass(70) === "b-strong", "70 is the bottom of Strong");
ok(bandClass(55) === "b-good", "55 is the bottom of Good");
ok(bandClass(35) === "b-fair", "35 is the bottom of Fair");
ok(bandClass(0) === "b-weak", "0 is Weak");
ok(bandClass(null) === "b-weak", "an unscored role is Weak, never undefined");

ok(urgencyLevel(0) === "now", "closing today is now");
ok(urgencyLevel(-4) === "now", "already overdue is still now, not later");
ok(urgencyLevel(URGENCY_NOW_DAYS) === "now", `${URGENCY_NOW_DAYS} days is the last day of now`);
ok(urgencyLevel(URGENCY_NOW_DAYS + 1) === "soon", `${URGENCY_NOW_DAYS + 1} days is soon`);
ok(urgencyLevel(URGENCY_SOON_DAYS) === "soon", `${URGENCY_SOON_DAYS} days is the last day of soon`);
ok(urgencyLevel(URGENCY_SOON_DAYS + 1) === "later", `${URGENCY_SOON_DAYS + 1} days is later`);
// A window with no date must take NO colour. Rendering "no date" in red would
// be the McKinsey failure in a new costume: a guess presented as a countdown.
ok(urgencyLevel(null) === null, "no close date has no urgency");
ok(urgencyClass(null) === "", "no close date gets no class at all");
ok(urgencyClass(3) === "u-now", "3 days gets the u-now class");

ok(evidenceClass("verified") === "v-strong", "read from the firm's own site is strong");
ok(evidenceClass("secondary-source") === "v-weak", "two trackers agreeing is still weak");
ok(evidenceClass("historical-estimate") === "v-weak", "an estimate is weak");
ok(evidenceClass(undefined) === "v-weak", "an unknown confidence is weak, never strong");
ok(provenanceClass("good") === "v-strong", "a real publish date is strong");
ok(provenanceClass("weak") === "v-none", "a last-edit date is not evidence");

/* --------------------------------------------------------- the categories */

const NAMES = CATEGORIES.map(([k]) => k);
ok(NAMES.length === 4, `there are ${NAMES.length} categories and the palette has 4 hues`);
ok(NAMES.join(",") === "defense,product,consulting,vc",
   `the four categories are ${NAMES.join(", ")} — the token names must match`);
for (const k of NAMES) {
  ok(token[`--cat-${k}`], `category ${k} has no --cat-${k} token`);
  ok(categoryClass(k) === `cat-${k}`, `category ${k} maps to cat-${k}`);
}
// An unknown category renders NO dot. A default dot would assert a category
// nobody chose, on a row where the honest answer is "not classified".
ok(categoryClass("fintech") === "", "an unknown category gets no class");
ok(categoryClass(undefined) === "", "an absent category gets no class");

// The baked lookups. These come from companies.yaml through genconfig, so a
// failure here means the yaml or the parser moved, not that the mapping is wrong.
ok(categoryOfCompany("palantir") === "defense",
   "Palantir is defense — it sits under `lever:` and needs the explicit key");
ok(categoryOfCompany("andurilindustries") === "defense",
   "Anduril is defense from its group name, with no explicit key");
ok(categoryOfCompany("stripe") === "product",
   "Stripe is product — four of its postings are tagged vc in the jobs table and it is not a venture firm");
ok(categoryOfCompany("bvpanalyst") === "vc", "Bessemer's analyst board is vc");
ok(categoryOfCompany("nobody-has-this-slug") === "product",
   "an unknown slug defaults to product rather than throwing");
ok(categoryOfFirm("McKinsey") === "consulting", "McKinsey is consulting");
ok(categoryOfFirm("Google APM") === "product", "Google's APM programme is product");
ok(categoryOfFirm("Bessemer Venture Partners") === "vc", "Bessemer the firm is vc");
ok(categoryOfFirm("Not A Real Firm") === null,
   "an unknown firm gets null, so CategoryDot renders nothing rather than a wrong dot");

/* ------------------------------------------------------------- progress */

ok(progressOf(0, 0).pct === 0, "an empty population is 0%, not NaN");
ok(progressOf(9, 25).pct === 36, "9 of 25 is 36%");
ok(progressOf(30, 25).pct === 100, "done cannot exceed total, so the bar cannot run off the page");
ok(progressOf(-3, 25).done === 0, "a negative count clamps to zero");

// ONE POPULATION. A closed window and a window for another graduating class are
// not dates anybody is waiting on, so they are in neither half of the fraction.
// The sentence this replaced counted them in the denominator and not in the
// numerator, which is two populations on one row.
const W = [
  { firm: "A", closes: "2026-09-30", status: "open" },
  { firm: "B", closes: null, status: "unconfirmed" },
  { firm: "C", closes: "2026-08-11", status: "closed" },
  { firm: "D", closes: null, status: "wrong_class_year" },
];
ok(trackableWindows(W).length === 2, "closed and wrong-class-year windows are not tracked");
ok(windowProgress(W).done === 1 && windowProgress(W).total === 2,
   `window progress is ${windowProgress(W).done} of ${windowProgress(W).total}, expected 1 of 2`);
ok(windowProgress([]).total === 0, "no windows is 0 of 0, not a crash");

/* ------------------------------------------- one source for every meaning */

/**
 * The semantic rules must reference TOKENS, never raw hex.
 *
 * This is what "a Strong band is the same blue everywhere" actually rests on.
 * The mapping being single-sourced in bandClass() is only half of it — a
 * component or a rule that hardcodes #2563eb would look right on the day it was
 * written and drift silently the first time a token is retuned, which is the
 * exact failure a token file exists to prevent.
 *
 * Checked over the RULES, in globals.css, because that is where a colour can be
 * written by hand. tokens.css is where hex belongs and is deliberately exempt.
 */
{
  const rules = fs.readFileSync("app/globals.css", "utf8");
  const SEMANTIC = /^\s*\.(scorebar\.b-|role\.b-|row\.b-|crow\.b-|u-|when\.u-|days\.u-|label\.v-|dot\.cat-|meter-|costbar)/;
  const offenders = [];
  for (const line of rules.split("\n")) {
    if (!SEMANTIC.test(line)) continue;
    // A hex literal inside a selector line's declaration block.
    const decl = line.slice(line.indexOf("{") + 1);
    const hex = decl.match(/#[0-9a-fA-F]{3,8}\b/);
    if (hex) offenders.push(`${line.trim().slice(0, 80)}  ->  ${hex[0]}`);
  }
  ok(offenders.length === 0,
     `a semantic colour rule hardcodes a hex value instead of a token:\n        ${offenders.join("\n        ")}`);
}

// And every token the rules ask for must actually EXIST. A var(--typo) resolves
// to nothing and the property is simply dropped — no error, no warning, and a
// band that renders in the inherited colour looks like a design decision.
{
  const rules = fs.readFileSync("app/globals.css", "utf8");
  const defined = new Set(Object.keys(token));
  for (const m of fs.readFileSync("app/tokens.css", "utf8").matchAll(/(--[a-z0-9-]+):/g)) {
    defined.add(m[1]);
  }
  // The pre-existing tokens live in globals.css's own :root block.
  for (const m of rules.matchAll(/(--[a-z0-9-]+):/g)) defined.add(m[1]);
  const missing = new Set();
  for (const m of rules.matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (!defined.has(m[1])) missing.add(m[1]);
  }
  ok(missing.size === 0,
     `globals.css uses ${[...missing].join(", ")}, which nothing defines — var() of an undefined token drops the property silently`);
}

/* ------------------------------------------------------- positive control */

// Prove the contrast checker can say no. #b9c1cb is --bar: a light grey that is
// perfectly good as a bar and completely unreadable as text on this page.
const bad = contrast("#b9c1cb", PAPER);
ok(bad < 4.5,
   `the control colour #b9c1cb scores ${bad.toFixed(2)}:1, which PASSES — the contrast checker is broken and every check above is worthless`);

/* ------------------------------------------------------------------ report */

console.log(`${pass} checks passed, ${Object.keys(token).length} colours read from tokens.css`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
