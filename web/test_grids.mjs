/**
 * A ROW GRID MAY BE RE-SIZED. IT MUST NEVER BE RE-COUNTED.
 *
 *   node test_grids.mjs
 *
 * Every table in this app is a CSS grid with a fixed column list, and each list
 * is declared more than once — narrower widths at 1280, a page-specific set
 * further down the file. All of that is legitimate. What is not legitimate is a
 * later declaration with a DIFFERENT NUMBER of columns, because grid neither
 * errors on a mismatch nor overflows: it opens a new implicit row and drops the
 * extra child into column one.
 *
 * That is not hypothetical. Companies' .crow was declared with seven columns —
 * the seventh being the ⋯ menu — and re-declared 75 lines later with six. Six
 * won. All 21 rows grew a second line with a ⋯ sitting under the company name,
 * left-aligned, and it read as a mobile control leaking into desktop rather
 * than as a column count.
 *
 * The same sweep found two more. .prow was Gate's three-column phrase table AND
 * Pulse's five-column source table — one name, two tables — so Gate rendered
 * into the wrong widths at every size, and below 1280 Gate's own media rule won
 * back and wrapped two of Pulse's five cells onto a second row. Neither page
 * errored. Neither looked broken enough to investigate.
 *
 * Counting is the whole test. Widths are a judgement; a count is a fact.
 */
import fs from "node:fs";
import path from "node:path";

const CSS = path.join("app", "globals.css");
const css = fs.readFileSync(CSS, "utf8");

/**
 * How many columns a `grid-template-columns` value declares.
 *
 * minmax(0, 1fr) and repeat(2, 1fr) carry commas and spaces of their own, so
 * every bracketed group collapses to one token before the split — otherwise a
 * single minmax() counts as three columns and the test reports a phantom.
 */
export function countColumns(value) {
  return value
    .replace(/\([^()]*\)/g, "X")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Every `.<sel>row { ... grid-template-columns: ... }` in the file. */
export function readRowGrids(source) {
  const grids = new Map();
  source.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(
      /(?:^|[{}\s])(\.[a-zA-Z][\w-]*)\s*\{[^{}]*grid-template-columns:\s*([^;}]+)/);
    if (!m) return;
    const sel = m[1];
    if (!/row$/.test(sel)) return; // the row grids, not every grid in the file
    if (!grids.has(sel)) grids.set(sel, []);
    grids.get(sel).push({ n: countColumns(m[2]), value: m[2].trim(), line: i + 1 });
  });
  return grids;
}

/**
 * The one legitimate recount, and why it has to be written down.
 *
 * A row may genuinely lose a cell at a breakpoint — Forecast's .drow hides its
 * note column below 1280 with `display: none`, so five columns there is the fix
 * rather than the bug. That edit and the .crow bug are indistinguishable from
 * the column list alone: both are "the same selector, fewer columns, lower down
 * the file". The difference lives in whether a child was actually removed.
 *
 * So the exception is DECLARED, in a comment beside the rule that earns it —
 * `grid-recount-ok: .drow — <reason>`. It costs one line to allow, cannot be
 * granted by accident, and shows up in a diff as what it is.
 */
export function readExemptions(source) {
  const out = new Map();
  for (const m of source.matchAll(/grid-recount-ok:\s*(\.[a-zA-Z][\w-]*)\s*—?\s*([^\n*]*)/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const grids = readRowGrids(css);
const exempt = readExemptions(css);

const recounted = [];
for (const [sel, decls] of grids) {
  if (exempt.has(sel)) continue;
  // A deliberate collapse to ONE column on a phone is the other legitimate
  // recount: the row stops being a row on purpose. Two distinct counts above
  // one is the bug.
  const real = decls.filter((d) => d.n > 1);
  if (new Set(real.map((d) => d.n)).size > 1) recounted.push([sel, real]);
}

/**
 * PROVE IT CAN FAIL. A test that has only ever passed is indistinguishable from
 * one that cannot, and this one is a regex over a 2,000-line stylesheet — every
 * way it could silently match nothing ends in a confident green.
 *
 * Two positive assertions, then the bug that prompted the file, re-injected.
 */
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

ok(grids.size >= 6,
   `only ${grids.size} row grids found in globals.css — the selector regex has stopped matching and this test is measuring nothing`);
ok([...grids.values()].some((d) => d.length > 1),
   "no row grid is declared more than once — that is the only thing this test can catch, so it is now checking nothing");
{
  const probe = readRowGrids(
    ".xrow { grid-template-columns: 1fr 60px 80px; }\n"
    + "@media (max-width: 1280px) { .xrow { grid-template-columns: 1fr 60px; } }\n");
  const d = (probe.get(".xrow") || []).filter((x) => x.n > 1);
  ok(new Set(d.map((x) => x.n)).size === 2,
     "the negative control did not trip: a 3-column grid re-declared as 2 was not reported, so a real recount would not be either");
  ok(countColumns("minmax(0, 1fr) 300px") === 2,
     "countColumns miscounts a minmax() — bracketed groups must collapse to one token");
  // An exemption must be an explicit grant, never something a stray word in a
  // comment can hand out. Both halves are checked: that the marker is read, and
  // that ordinary prose about the subject does not read as one.
  ok(readExemptions("/* grid-recount-ok: .zrow — cell hidden here */").get(".zrow"),
     "the grid-recount-ok marker is no longer parsed, so every exemption is silently ignored");
  ok(readExemptions("/* .zrow is recounted at this breakpoint, which is fine */").size === 0,
     "prose mentioning a recount was read as an exemption — the marker is too loose to be a grant");
}
for (const [sel, why] of exempt) {
  ok(why.length > 0, `${sel} is exempt from the column-count check with no reason given — an unexplained exemption is a silent one`);
}

for (const f of fails) console.log(`  SELF-CHECK FAILED: ${f}`);

if (recounted.length) {
  console.log(`\n${recounted.length} ROW GRID${recounted.length === 1 ? "" : "S"} DECLARED WITH DIFFERENT COLUMN COUNTS`);
  console.log("the extra cells wrap onto an implicit row, left-aligned, and nothing errors:\n");
  for (const [sel, decls] of recounted) {
    console.log(`  ${sel}`);
    for (const d of decls) {
      console.log(`      line ${String(d.line).padStart(4)}   ${d.n} cols   ${d.value}`);
    }
  }
}

if (fails.length || recounted.length) process.exit(1);
console.log(`${grids.size} row grids, ${[...grids.values()].reduce((s, d) => s + d.length, 0)} declarations, every one agreeing with its siblings on column count`);
