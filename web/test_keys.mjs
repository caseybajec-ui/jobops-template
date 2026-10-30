/**
 * The palette's matching and the keyboard map. Run: node test_keys.mjs
 *
 * The keyboard half is tested harder than it looks like it deserves, because
 * its failure mode is silent and destructive: every single-key shortcut in this
 * app is a letter, and the page is full of text boxes. Typing the word "save"
 * into the add-item field would otherwise hide a role, mark another applied and
 * open a dialog — and the sentence being typed would be gone.
 */
import { score, search, PAGES, KINDS } from "./lib/search.js";
import { shortcutFor, isTyping, SHORTCUTS } from "./lib/keys.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- the matching */

ok(score("sar", "Saronic") > 0, "a prefix matches");
ok(score("sar", "Saronic") > score("sar", "Saronic Mission Operations Engineer"),
   "and the shorter target wins, so the company beats its longest role");
ok(score("mission", "Mission Operations Engineer") > 0, "a word start matches");
ok(score("ops", "Mission Operations Engineer") > 0, "a word start mid-string matches");
// SUBSEQUENCE, not substring. The point of a palette is typing what you
// remember, in the order you remember it.
ok(score("dstrat", "Deployment Strategist") > 0, "a scattered subsequence matches");
ok(score("dplystrat", "Deployment Strategist") > 0, "even a loose one");
eq(score("zzz", "Deployment Strategist"), 0, "and nonsense matches nothing");
eq(score("", "anything"), 0, "an empty query scores nothing");
eq(score("x", ""), 0, "and empty text is never a match");

// Ranking order: exact prefix > word start > substring > subsequence.
ok(score("dep", "Deployment") > score("dep", "Forward Deployed"),
   "an exact prefix beats a word start");
ok(score("dep", "Forward Deployed") > score("dpt", "Deployment"),
   "and a word start beats a scattered subsequence");

/* --------------------------------------------------------------- the list */

const ITEMS = [
  ...PAGES.map(([href, label]) => ({ kind: "page", label, href })),
  { kind: "company", label: "Saronic", sub: "10 roles", href: "/inbox?co=saronic" },
  { kind: "role", label: "Associate Product Manager", sub: "Saronic", href: "#a" },
  { kind: "role", label: "Deployment Strategist - US Government", sub: "Palantir", href: "#b" },
  { kind: "person", label: "A Name", sub: "Palantir", href: "/people" },
  { kind: "task", label: "Confirm BCG's undergraduate deadline", href: "/#items" },
];

{
  // The acceptance criterion the brief names: "sar" surfaces the company AND
  // its roles, company first.
  const r = search("sar", ITEMS);
  ok(r.length >= 2, "'sar' finds more than one thing");
  eq(r[0].label, "Saronic", "with the company first");
  ok(r.some((x) => x.kind === "role" && x.sub === "Saronic"),
     "and a role at that company, matched on its subtitle");
}
{
  const r = search("", ITEMS);
  ok(r.length > 0, "an empty query is not an empty palette");
  ok(r.every((x) => x.kind === "page"), "it shows the pages");
  eq(r[0].label, "Daily", "in their own order, not alphabetically");
}
{
  const r = search("pulse", ITEMS);
  eq(r[0].href, "/pulse", "a page is reachable by name");
}
{
  // STABLE ORDER. A palette whose rows move under the cursor between identical
  // keystrokes is one you stop pressing Enter in.
  const a = search("a", ITEMS).map((x) => x.label);
  const b = search("a", ITEMS).map((x) => x.label);
  eq(a, b, "the same query gives the same order every time");
}
eq(search("zzzzz", ITEMS), [], "and no match is an empty list, not everything");

ok(KINDS.length === 5, "five kinds of thing are searchable");

/* -------------------------------------------------------- the keyboard map */

const ev = (key, opts = {}) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, target: null, ...opts });

eq(shortcutFor(ev("j")), "down", "j moves down");
eq(shortcutFor(ev("k")), "up", "k moves up");
eq(shortcutFor(ev("s")), "save", "s saves");
eq(shortcutFor(ev("h")), "hide", "h hides");
eq(shortcutFor(ev("a")), "applied", "a marks applied");
eq(shortcutFor(ev("x")), "toggle", "x ticks a task");
eq(shortcutFor(ev("?")), "help", "? shows the map");
eq(shortcutFor(ev("Escape")), "escape", "Escape closes");
eq(shortcutFor(ev("Enter")), "open", "Enter opens the focused row");
eq(shortcutFor(ev("q")), null, "an unmapped key does nothing");

eq(shortcutFor(ev("k", { metaKey: true })), "palette", "Cmd-K opens the palette");
eq(shortcutFor(ev("k", { ctrlKey: true })), "palette", "and so does Ctrl-K");

// MODIFIERS ARE THE BROWSER'S. Stealing Cmd-S or Cmd-A gets reported as "the
// browser is broken", and rightly.
eq(shortcutFor(ev("s", { metaKey: true })), null, "Cmd-S stays save-page");
eq(shortcutFor(ev("a", { ctrlKey: true })), null, "Ctrl-A stays select-all");
eq(shortcutFor(ev("j", { altKey: true })), null, "and Alt is left alone");

/* ------------------------------------------- THE RULE: never while typing */

const el = (tagName, extra = {}) => ({ tagName, getAttribute: () => null, ...extra });

for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
  ok(isTyping(el(tag)), `${tag} counts as typing`);
  eq(shortcutFor(ev("s", { target: el(tag) })), null,
     `s does nothing inside a ${tag} — otherwise typing "save" hides a role`);
  eq(shortcutFor(ev("h", { target: el(tag) })), null, `nor does h inside a ${tag}`);
  eq(shortcutFor(ev("a", { target: el(tag) })), null, `nor a`);
  eq(shortcutFor(ev("x", { target: el(tag) })), null, `nor x`);
  eq(shortcutFor(ev("j", { target: el(tag) })), null, `nor j`);
  // Escape is the exception, and it has to be: it is how you get out of a field.
  eq(shortcutFor(ev("Escape", { target: el(tag) })), "escape",
     `but Escape still works inside a ${tag}`);
}

ok(isTyping(el("DIV", { isContentEditable: true })), "contenteditable counts too");
ok(isTyping(el("DIV", { getAttribute: (a) => (a === "role" ? "textbox" : null) })),
   "and so does role=textbox, however it is built");
ok(!isTyping(el("DIV")), "a plain div does not");
ok(!isTyping(el("BUTTON")), "and neither does a button");
ok(!isTyping(null), "a missing target is not typing");

// The palette must open even from inside a field: it is how you leave.
eq(shortcutFor(ev("k", { metaKey: true, target: el("INPUT") })), "palette",
   "Cmd-K opens the palette even while typing");

ok(SHORTCUTS.length >= 9, "the help overlay has something to list");
ok(SHORTCUTS.every(([, label, where, does]) => label && where && does),
   "and every row says the key, where it works, and what it does");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
