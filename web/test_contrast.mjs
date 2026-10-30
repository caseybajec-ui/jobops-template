/**
 * Every text token passes WCAG AA on the ground it actually sits on.
 * Run: node test_contrast.mjs
 *
 * The tokens carry measured ratios in their comments. A comment is not a test —
 * this reads the hex values out of tokens.css and globals.css, computes the
 * ratios, and fails if one is short. Adding a colour with a number written
 * beside it is how you end up with a number that used to be true.
 *
 * THE GROUND MATTERS AND IS THE EASY PART TO GET WRONG. A chip's text sits on
 * the chip's tint, not on the page, and checking it against --paper would pass
 * a pairing nobody ever sees. Every row below names its own background.
 *
 * It prints the full table, because the brief asked for the report and because
 * a check whose output is only "ok" tells you nothing when you later want to
 * know how much headroom a colour has.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------- read the real values */

const css = ["app/tokens.css", "app/globals.css"]
  .map((f) => fs.readFileSync(path.join(here, f), "utf8")).join("\n");

const TOK = {};
for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  // FIRST definition wins, matching the cascade for the :root blocks here —
  // and if a token is ever redefined later this test should be reading the same
  // value the browser does, so a duplicate is worth knowing about.
  if (!(m[1] in TOK)) TOK[m[1]] = m[2];
}

// The self-check. If the regex stops matching — a token moves into a media
// query, a value becomes a var() reference — this file would sail through with
// an empty table and report success. That is the failure mode every
// verification tool in this repo is required to guard against.
const MIN_TOKENS = 20;
if (Object.keys(TOK).length < MIN_TOKENS) {
  console.error(`\ntest_contrast: only found ${Object.keys(TOK).length} colour tokens `
    + `(expected at least ${MIN_TOKENS}). The parser is not reading the stylesheets; `
    + `an empty table would print green.\n`);
  process.exit(1);
}

/* ------------------------------------------------------------- the arithmetic */

function rgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ------------------------------------------------- what sits on what, exactly */

const PAPER = "--paper";
const CARD = "--card";

// [token, background, minimum, note]
//
// 4.5 is AA for body text. 3.0 is AA for LARGE text and for non-text graphics —
// used only where the token is never rendered as body copy: bar fills, rules,
// and the two progress segments, whose job is to be distinguishable from each
// other rather than to be read.
const ROWS = [
  ["--ink", PAPER, 4.5, "body text"],
  ["--graphite", PAPER, 4.5, "captions, labels, metadata"],
  ["--graphite", CARD, 4.5, "the same, on a raised surface"],
  ["--alert", PAPER, 4.5, "the one accent"],

  ["--band-excellent", PAPER, 4.5, "fit band word"],
  ["--band-strong", PAPER, 4.5, "fit band word"],
  ["--band-good", PAPER, 4.5, "fit band word"],
  ["--band-fair", PAPER, 4.5, "fit band word"],
  ["--band-weak", PAPER, 4.5, "fit band word"],

  ["--u-now", PAPER, 4.5, "urgency text"],
  ["--u-soon", PAPER, 4.5, "urgency text"],
  ["--u-later", PAPER, 4.5, "urgency text"],

  ["--v-strong", PAPER, 4.5, "verification text"],
  ["--v-weak", PAPER, 4.5, "verification text"],
  ["--v-none", PAPER, 4.5, "verification text"],

  ["--cat-defense", PAPER, 4.5, "category dot"],
  ["--cat-product", PAPER, 4.5, "category dot"],
  ["--cat-consulting", PAPER, 4.5, "category dot"],
  ["--cat-vc", PAPER, 4.5, "category dot"],

  // Chips: the text sits on the CHIP, never on the page.
  ["--u-now", "--u-now-tint", 4.5, "urgency chip, 1-7 days"],
  ["--u-soon", "--u-soon-tint", 4.5, "urgency chip, 8-30 days"],
  ["--u-later", "--u-later-tint", 4.5, "urgency chip, 31+ days"],
  ["--v-strong", "--v-strong-tint", 4.5, "confirmed chip"],
  ["--graphite", "--u-later-tint", 4.5, "status chip"],
  // The one filled pill: white ON the red, which is the reverse of every other
  // row here and therefore the one most likely to be wrong.
  ["--paper", "--u-now", 4.5, "TODAY pill, reversed"],

  // Non-text. 3:1 is the standard for a graphic that only has to be told apart.
  ["--rule", PAPER, 1.2, "hairline rules — structural, deliberately faint"],
  ["--p-done", "--p-track", 3.0, "progress fill, against its track"],
  ["--band-excellent-fill", PAPER, 3.0, "band bar fill"],
  ["--band-strong-fill", PAPER, 3.0, "band bar fill"],
  ["--band-good-fill", PAPER, 3.0, "band bar fill"],
];

let pass = 0;
const fails = [];

console.log("\n  token                     on                 ratio   min   what");
console.log("  " + "-".repeat(84));
for (const [tok, bg, min, note] of ROWS) {
  if (!TOK[tok]) { fails.push(`${tok} is not defined`); continue; }
  if (!TOK[bg]) { fails.push(`${bg} is not defined`); continue; }
  const r = ratio(TOK[tok], TOK[bg]);
  const ok = r >= min;
  if (ok) pass++; else fails.push(`${tok} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1 (${note})`);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${tok.padEnd(22)} ${bg.padEnd(17)} `
    + `${r.toFixed(2).padStart(5)}  ${String(min).padStart(4)}   ${note}`);
}

/* ---------------------------------------------- and a check that it can fail */
//
// A contrast test that has only ever passed is indistinguishable from one that
// cannot. Grey on grey must come out below AA; if this ever "passes", the
// arithmetic is broken and every row above is meaningless.
{
  const bad = ratio("#9aa3ad", TOK[PAPER]);
  if (bad >= 4.5) fails.push(`the negative control scored ${bad.toFixed(2)}:1 — the maths is wrong`);
  else { pass++; console.log(`\n  ok   negative control: mid-grey on paper is ${bad.toFixed(2)}:1, correctly short of AA`); }
}

// Everything the app renders as text must be at least 11px. Caught by reading
// the stylesheet rather than the screen, because the sizes are all literals.
{
  const small = [];
  for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
    if (Number(m[1]) < 11) small.push(m[1] + "px");
  }
  if (small.length) fails.push(`text below 11px: ${[...new Set(small)].join(", ")}`);
  else { pass++; console.log(`  ok   no rule sets text below 11px`); }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("\nFAILED:"); for (const f of fails) console.log("  " + f); }
process.exit(fails.length ? 1 : 0);
