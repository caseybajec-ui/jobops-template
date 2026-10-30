/**
 * Prove the hard-rule assertions can actually FAIL. Run: node audit_mutation.mjs
 *
 * WHY. The clearance-phrasing assertion in web/test_writes.mjs was dead for
 * weeks — its `\b` escapes had collapsed into literal 0x08 bytes, so the regex
 * matched nothing and the check passed whatever the page said. The control-byte
 * guard in test_line_endings.py now catches that MECHANISM across every tracked
 * file. It does not, and cannot, tell you that an assertion is LIVE.
 *
 * Only one thing can: break the code on purpose and watch the test go red.
 *
 * So this patches a source module so it emits text the rule forbids, runs the
 * test that guards it, and requires a non-zero exit. Then it restores the file
 * and requires the test to go green again — because a mutation harness that
 * left a repo broken, or that reported red because it had corrupted something
 * unrelated, would be worse than none.
 *
 * WHAT IS COVERED. Every negative assertion protecting a rule from CLAUDE.md
 * that is stated as "never":
 *
 *   - the clearance phrasing, on all four surfaces that render it
 *   - "never emit a bracket", on the two that generate text
 *   - "never manufacture a connection", on the outreach templates
 *
 * These are the assertions whose silent death costs something unrecoverable: a
 * false claim on a federal form, a placeholder in a document the owner sends, or a
 * fabricated relationship in a message to a real person. Everything else in the
 * suite fails loudly when the code is wrong; these fail silently when the TEST
 * is wrong, which is the case that needs proving.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, "web");

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, console.log(`  ok    ${what}`))
                                 : (fails.push(what), console.log(`  FAIL  ${what}`)));

/**
 * Each mutation names the rule it is breaking, so a failure here reads as
 * "this rule is unguarded" rather than as a broken tool.
 */
const MUTATIONS = [
  {
    rule: "clearance phrasing — the fit explanation",
    file: "lib/why.js",
    test: "test_why.mjs",
    // Every clearance branch returns text; poisoning the module's own wording
    // is the honest mutation, because that is exactly how a real regression
    // would arrive: someone rewords a sentence.
    find: "No clearance mentioned in the posting.",
    poison: (s) => s.replace("No clearance mentioned in the posting.",
                             "You are eligible for a clearance."),
  },
  {
    rule: "clearance phrasing — the interview prep checklist",
    file: "lib/lifecycle.js",
    test: "test_lifecycle.mjs",
    find: "no current or prior clearance",
    poison: (s) => s.replace("no current or prior clearance",
                             "you are eligible and is cleared"),
  },
  {
    rule: "clearance phrasing — the SF-86 export",
    file: "lib/sf86.js",
    test: "test_sf86.mjs",
    find: "(nothing recorded yet)",
    poison: (s) => s.replace("(nothing recorded yet)",
                             "(nothing recorded yet — you are cleared and eligible)"),
  },
  {
    rule: "never emit a bracket — the prep checklists",
    file: "lib/lifecycle.js",
    test: "test_lifecycle.mjs",
    find: "Why defense, and why now?",
    poison: (s) => s.replace("Why defense, and why now?",
                             "Why [COMPANY], and why now?"),
  },
  {
    rule: "never emit a bracket — the outreach templates",
    file: "lib/people.js",
    test: "test_people.mjs",
    find: "TEMPLATES",
    poison: (s) => s.replace(/const TEMPLATES = \[/,
                             'const TEMPLATES = [\n  { key: "zz_probe", label: "probe", subject: "x", body: "Hi {name}, [ASK CASEY]" },'),
  },
  {
    // NOT a "never" rule from CLAUDE.md, and it is here for the reason those
    // are: its silent death is unrecoverable and invisible. A blocked apply
    // flow that stops being excluded puts the owner back on a form that cannot be
    // submitted, every morning, with the tool insisting it is his best move.
    //
    // THE MUTATION IS THE DELETED CALL SITE, which is the failure this whole
    // file exists for — a predicate written, exported, documented and wired
    // into nothing. test_blocked.mjs injects both lookups and needs no
    // database, so unlike the write tests it actually runs here.
    rule: "blocked applies are excluded — the predicate is wired into visibleRoles",
    file: "lib/db.js",
    test: "test_blocked.mjs",
    find: "&& !isBlocked(r, b)",
    poison: (s) => s.replace("&& !isBlocked(r, b)", ""),
  },
  {
    // THE OTHER DIRECTION, and the expensive one. Keyed on the group instead of
    // the requisition, one looping hCaptcha in Chicago deletes eleven Palantir
    // postings — New York included — and a role the owner never learns exists is
    // the one loss this project treats as unrecoverable.
    rule: "a block hides ONE requisition, never the role group",
    file: "lib/blocked.js",
    test: "test_blocked.mjs",
    find: ".has(role.key)",
    poison: (s) => s.replace(".has(role.key)", ".has(role.groupKey)"),
  },
  {
    rule: "never manufacture a connection — no flattery in a template",
    file: "lib/people.js",
    test: "test_people.mjs",
    find: "TEMPLATES",
    poison: (s) => s.replace(/const TEMPLATES = \[/,
                             'const TEMPLATES = [\n  { key: "zz_probe2", label: "probe", subject: "x", body: "I have been following your work and would love to connect." },'),
  },
];

function run(test) {
  try {
    execFileSync(process.execPath, [test], { cwd: WEB, stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

console.log("\nMutation audit — breaking each hard rule and requiring its test to notice.\n");

for (const m of MUTATIONS) {
  const full = path.join(WEB, m.file);
  const original = fs.readFileSync(full, "utf8");

  if (!original.includes(m.find)) {
    fails.push(`${m.rule}: anchor ${JSON.stringify(m.find)} not found in ${m.file} — `
             + "the mutation could not be applied, so nothing was proved");
    console.log(`  FAIL  ${m.rule} — anchor missing in ${m.file}`);
    continue;
  }

  // GREEN FIRST. If the test is already red the mutation proves nothing.
  const before = run(m.test);
  if (before !== 0) {
    fails.push(`${m.rule}: ${m.test} was already failing before the mutation`);
    console.log(`  FAIL  ${m.rule} — ${m.test} was already red`);
    continue;
  }

  const poisoned = m.poison(original);
  if (poisoned === original) {
    fails.push(`${m.rule}: the poison changed nothing in ${m.file}`);
    console.log(`  FAIL  ${m.rule} — poison was a no-op`);
    continue;
  }

  let after;
  try {
    fs.writeFileSync(full, poisoned, "utf8");
    after = run(m.test);
  } finally {
    // ALWAYS restore, and verify the restore, before moving on. A harness that
    // leaves a poisoned module behind is a worse bug than the one it hunts.
    fs.writeFileSync(full, original, "utf8");
    if (fs.readFileSync(full, "utf8") !== original) {
      fails.push(`${m.rule}: FAILED TO RESTORE ${m.file} — fix this by hand`);
    }
  }

  ok(after !== 0, `${m.rule} — ${m.test} goes red when the rule is broken`);

  const restored = run(m.test);
  ok(restored === 0, `  …and green again once ${m.file} is restored`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  console.log("\nA rule listed above is NOT GUARDED: its test passes whether or not");
  console.log("the code obeys it. That is the state the clearance assertion was in.");
}
process.exit(fails.length ? 1 : 0);
