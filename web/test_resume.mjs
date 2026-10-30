/**
 * The two resume variants: who gets which, and what neither may say.
 *
 * Run: node test_resume.mjs
 *
 * The clearance half uses lib/clearance.js rather than its own regex, because
 * that file exists precisely so this rule has ONE definition. A fifth private
 * copy is how the fourth one rotted into literal 0x08 bytes and matched nothing
 * for weeks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VARIANTS, VARIANT_KEYS, KNOWN_CATEGORIES, variantForCategory, variantFor,
} from "./lib/variant.js";
import { forbiddenClaim, FORBIDDEN } from "./lib/clearance.js";
import { OWNER } from "./lib/config.generated.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..");
let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));

/* ------------------------------------------- 1. selection is a lookup, total */

ok(variantForCategory("defense") === "tech", "defense takes the tech resume");
ok(variantForCategory("product") === "tech", "product & tech takes the tech resume");
ok(variantForCategory("consulting") === "finance", "consulting takes the finance resume");
ok(variantForCategory("vc") === "finance", "VC & growth takes the finance resume");

// Every category the data actually contains must have an answer. companies.yaml
// is the source of that vocabulary; if a fifth category is added there and not
// here, this goes red rather than silently returning null on real roles.
const yaml = fs.readFileSync(path.join(REPO, "companies.yaml"), "utf8");
const inYaml = [...new Set(
  [...yaml.matchAll(/^\s*category:\s*([a-z_]+)\s*$/gim)].map((m) => m[1].toLowerCase()),
)].sort();
ok(inYaml.length > 0, `companies.yaml actually yielded categories (${inYaml.join(", ")})`);
for (const c of inYaml) {
  ok(variantForCategory(c) !== null,
     `companies.yaml category "${c}" maps to a variant`);
}
ok(KNOWN_CATEGORIES.slice().sort().join(",") === inYaml.join(","),
   `the map covers exactly the categories in companies.yaml\n`
   + `      map:  ${KNOWN_CATEGORIES.slice().sort().join(", ")}\n`
   + `      yaml: ${inYaml.join(", ")}`);

/* AN UNKNOWN CATEGORY IS NULL, NEVER A DEFAULT. A default here would put the
 * finance resume in front of a defense recruiter and say nothing about it. */
for (const bad of ["", "  ", "unknown", "biotech", null, undefined, 7, {}]) {
  ok(variantForCategory(bad) === null,
     `an unrecognised category (${JSON.stringify(bad)}) selects NO variant`);
}
ok(variantFor("nonsense") === null, "variantFor is null for the same");
ok(variantFor("DEFENSE").key === "tech", "matching is case-insensitive");
ok(variantFor(" consulting ").key === "finance", "and tolerates stray whitespace");

/* --------------------------------------- 2. both variants exist and are real */

for (const key of VARIANT_KEYS) {
  const v = VARIANTS[key];
  const md = path.join(REPO, v.source);
  const pdf = path.join(here, "public", "resume", v.filename);

  ok(fs.existsSync(md), `${v.source} exists`);
  ok(fs.existsSync(pdf), `${v.filename} is in web/public/resume/ and will be served`);
  ok(v.pdf === `/resume/${v.filename}`,
     `${key}'s download path matches the file on disk`);

  const text = fs.readFileSync(md, "utf8");
  // Not an empty or stub file: a variant that silently generated to nothing
  // would pass every assertion below it.
  ok(text.length > 1200, `${v.source} has real content (${text.length} chars)`);
  ok((text.match(/^- /gm) || []).length >= 6,
     `${v.source} kept its bullets (${(text.match(/^- /gm) || []).length})`);
  // The heading is the owner's name as the PDF prints it; the original
  // asserted one person's name in capitals. Case-insensitive, because resume
  // headers are usually capitals and profile.json is not.
  ok(new RegExp("^# " + OWNER.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "im").test(text),
     `${v.source} keeps the name heading`);

  /* ---- 3. the clearance rule, on the documents that go to defense primes ---- */
  const claim = forbiddenClaim(text);
  ok(claim === null,
     `${v.source} makes no adjudicated-clearance claim` + (claim ? ` — found "${claim}"` : ""));

  // NO BRACKETS EVER REACH AN OUTPUT FILE. an older draft resume was full of unfilled
  // [placeholders] and is one careless copy away from a sendable document.
  ok(!/\[[A-Z][^\]]*\]/.test(text), `${v.source} carries no [PLACEHOLDER] brackets`);
}

/* The check can fail: a forbidden phrasing in the same shape as the real text
 * must be caught. Without this, a clearance regex that had gone inert would
 * report both resumes clean and look identical to success. */
ok(FORBIDDEN.test("Holds an active TS/SCI clearance."),
   "the clearance check is live — it still catches an adjudicated claim");
ok(forbiddenClaim("US citizen; no clearance held; willing to undergo the process.") === null,
   "and still clears the permitted phrasing");

/* --------------------------------- 4. the two variants are actually different */

const techText = fs.readFileSync(path.join(REPO, VARIANTS.tech.source), "utf8");
const finText = fs.readFileSync(path.join(REPO, VARIANTS.finance.source), "utf8");
ok(techText !== finText, "the two variants are not the same document");
// The framing difference the owner built them for: the finance resume leads its
// skills with Analysis, the tech one with Engineering. If a regeneration ever
// collapses them into one file this is what notices.
const firstSkill = (t) => (t.match(/\*\*(Engineering|Analysis):\*\*/) || [])[1];
ok(firstSkill(techText) === "Engineering", "tech leads its skills with Engineering");
ok(firstSkill(finText) === "Analysis", "finance leads its skills with Analysis");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
