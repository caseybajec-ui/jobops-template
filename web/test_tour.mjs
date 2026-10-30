/**
 * The tour's pure logic: skipping, progress, and resuming. Run: node test_tour.mjs
 *
 * The renderer needs a browser and is covered by test_tour_targets.mjs. These are
 * the parts that decide WHAT is shown, and they are pure so that "why did it jump
 * from 3 to 5" is a question answered in a test rather than by clicking.
 */
import {
  INTERFACE_TOUR, TOURS, nextIndex, progress, resumeIndex, stepsOnPage,
} from "./lib/tour.js";

let pass = 0;
const fails = [];
const ok = (c, what) => (c ? pass++ : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const S = [
  { id: "a", page: "/", selector: ".a", title: "A", body: "..." },
  { id: "b", page: "/", selector: ".b", title: "B", body: "..." },
  { id: "c", page: "/x", selector: ".c", title: "C", body: "..." },
  { id: "d", page: "/x", selector: ".d", title: "D", body: "..." },
];

/* ------------------------------------------------------------- the data */

ok(INTERFACE_TOUR.length >= 12, "the interface tour has enough steps to be a tour");
ok(TOURS.interface === INTERFACE_TOUR, "the registry points at it");

for (const s of INTERFACE_TOUR) {
  ok(s.id && s.page && s.selector && s.title && s.body,
     `every step is complete: ${s.id || "(no id)"} is missing a field`);
  // A NAME, NOT JUST A NUMBER. A step whose title is "Step 4" would satisfy the
  // shape check and defeat the point of having titles.
  ok(!/^step\s*\d+$/i.test(s.title), `${s.id}: the title is a name, not a number`);
  ok(s.body.length > 40, `${s.id}: the body says something`);
  ok(s.page.startsWith("/"), `${s.id}: the page is a path`);
}
{
  const ids = INTERFACE_TOUR.map((s) => s.id);
  eq(ids.length, new Set(ids).size, "step ids are unique — progress is keyed by them");
}

/* ------------------------------------------------------------ selection */

eq(stepsOnPage(S, "/").map((s) => s.id), ["a", "b"], "steps on a page, in order");
eq(stepsOnPage(S, "/nope"), [], "a page with no steps is empty, not an error");

/* --------------------------------------------------------- skip and walk */

eq(nextIndex(S, 0, 1), 1, "forward one");
eq(nextIndex(S, 1, 1, new Set(["c"])), 3, "a skipped step is stepped over");
eq(nextIndex(S, 1, 1, new Set(["c", "d"])), null,
   "nothing left forward returns null, so the tour ENDS rather than clamping to a "
   + "final card whose Next button does nothing");
eq(nextIndex(S, 0, -1), null, "nothing left backward returns null");
eq(nextIndex(S, 3, -1, new Set(["c", "b"])), 0, "backward skips too");
eq(nextIndex(S, 0, 1, new Set(["a", "b", "c", "d"])), null,
   "every step skipped is an empty tour, not a crash");

/* ---------------------------------------------------------- the counter */

eq(progress(S, 0), { at: 1, total: 4 }, "first of four");
// THE COUNT MUST DESCRIBE WHAT IS SHOWN. With two steps skipped, "3 of 4" would
// promise a tour that ends at 2 — the same two-populations bug this codebase has
// found on four other rows.
eq(progress(S, 3, new Set(["b", "c"])), { at: 2, total: 2 },
   "skipped steps leave both halves of the counter, not just the total");
eq(progress(S, 1, new Set(["a"])), { at: 1, total: 3 }, "and the position shifts with it");

/* ------------------------------------------------------------- resuming */

eq(resumeIndex(S, "c"), 2, "resume lands on the stored step");
eq(resumeIndex(S, null), 0, "no stored step starts at the beginning");
// KEYED BY ID, NOT INDEX. A stored index points at a different step the moment
// one is inserted above it — and inserting steps is the entire point of the data
// file. An id that no longer exists restarts rather than throwing.
eq(resumeIndex(S, "gone"), 0, "a step that no longer exists restarts the tour");
{
  const grown = [{ id: "new", page: "/", selector: ".n", title: "N", body: "..." }, ...S];
  eq(resumeIndex(grown, "c"), 3, "inserting a step above does not move where you resume");
}

console.log(`${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFAILURES:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
