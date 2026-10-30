/**
 * Bake config.yaml into the bundle at BUILD time. Run by `prebuild`/`predev`.
 *
 * Why this exists, and why the obvious version was worse:
 *
 * cost.js used to read `../config.yaml` at REQUEST time. Locally the meter said
 * $3.17. Deployed it said **$29.88 / $5.00 OVER CAP** in red on every page —
 * the LIFETIME figure, because the read threw, a bare `catch {}` swallowed it,
 * and the fallback `"1970-01-01"` made every batch ever submitted count as this
 * month's spend. The number the owner checks before deciding whether he can afford
 * to score anything was wrong, in production only, and looked authoritative.
 *
 * The reason only THAT read failed is worth writing down. Five other modules
 * read repo-root files the same way and all of them work on Vercel, because the
 * build tracer can statically evaluate a MODULE-LEVEL const:
 *
 *     const YAML = path.join(process.cwd(), "..", "companies.yaml");   // traced
 *
 * capReset() built the same expression INSIDE a function body, the tracer never
 * saw it, and config.yaml was simply not in the deployed bundle. That is far too
 * fine a distinction to leave load-bearing: nobody refactoring cost.js would
 * know that hoisting a constant is what keeps the file shipping.
 *
 * So the value stops travelling by filesystem. It is read here, at build time,
 * on a machine that certainly has the repo, and written into a real module that
 * `import` traces like any other code. If config.yaml is missing or unreadable
 * the BUILD FAILS — it does not fall back to a default that silently changes
 * what the number means.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The one definition of which triggers exist. See NOTIFY below.
//
// FROM triggers.js, NOT notify.js. notify.js imports transfer.js, which reads
// the module this script WRITES -- so importing it here closed a build-time
// cycle that worked on a machine with a previous build lying around and
// failed with ERR_MODULE_NOT_FOUND on a fresh clone. triggers.js has no
// imports of its own, which is what makes it safe to read at build time.
import { TRIGGERS } from "./triggers.js";

const here = path.dirname(fileURLToPath(import.meta.url));   // web/lib
const SOURCE = path.join(here, "..", "..", "config.yaml");   // repo root
const PROFILE = path.join(here, "..", "..", "profile.json");
const COMPANIES = path.join(here, "..", "..", "companies.yaml");
const DEST = path.join(here, "config.generated.js");

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
                "august", "september", "october", "november", "december"];

function die(msg) {
  console.error(`\ngenconfig: ${msg}\n`);
  console.error(`  source: ${SOURCE}`);
  console.error(`  This is a hard failure on purpose. The last time a missing`);
  console.error(`  cap_reset defaulted quietly, the deployed cost meter read`);
  console.error(`  $29.88 / $5.00 OVER CAP against a cap that had been reset.\n`);
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(SOURCE, "utf8");
} catch (e) {
  die(`cannot read config.yaml (${e.code || e.message})`);
}

const reset = raw.match(/cap_reset:\s*'?([0-9T:+\-]{10,})'?/);
if (!reset) die("config.yaml has no parseable cost.cap_reset");

const cap = raw.match(/monthly_cap:\s*([0-9]+(?:\.[0-9]+)?)/);
if (!cap) die("config.yaml has no parseable cost.monthly_cap");

/* ------------------------------------------------------ the Neon allowance
 *
 * A fact about the ACCOUNT, so it lives in config.yaml rather than as a
 * constant in lib/transfer.js, where it was hardcoded to the free tier's 5 GB
 * and stayed there through the upgrade to Launch. Neon reports usage but never
 * the limit, so nothing can derive this; somebody has to state it.
 *
 * MISSING FAILS THE BUILD, like cap_reset and for the same reason. A default
 * here would not be a missing number, it would be a WRONG one: every
 * percentage, the warn threshold and the EXHAUSTED message all divide by it,
 * so a quiet fallback to 5 GB would put the digest permanently in the red on a
 * 500 GB plan and teach the owner to ignore the one line that matters the month it
 * runs out.
 */
const allowanceGb = raw.match(/transfer_allowance_gb:\s*([0-9]+(?:\.[0-9]+)?)/);
if (!allowanceGb) die("config.yaml has no parseable database.transfer_allowance_gb");
const ALLOWANCE_GB = Number(allowanceGb[1]);
if (!Number.isFinite(ALLOWANCE_GB) || ALLOWANCE_GB <= 0) {
  die(`database.transfer_allowance_gb is ${allowanceGb[1]}, which is not a `
    + "positive number of gigabytes.");
}

const warnAt = raw.match(/transfer_warn_at:\s*([0-9]*\.?[0-9]+)/);
if (!warnAt) die("config.yaml has no parseable database.transfer_warn_at");
const WARN_FRACTION = Number(warnAt[1]);
// A FRACTION, NOT A PERCENTAGE. `0.70` and `70` are both plausible things to
// type and they differ by 100x; written as 70 the threshold would never fire
// at all, and the digest would go from crying wolf to saying nothing. Rejecting
// anything outside (0, 1] costs one line and removes the ambiguity.
if (!Number.isFinite(WARN_FRACTION) || WARN_FRACTION <= 0 || WARN_FRACTION > 1) {
  die(`database.transfer_warn_at is ${warnAt[1]}. It must be a FRACTION in `
    + "(0, 1] -- 0.70 for seventy percent, not 70.");
}

// Graduation drives the one framing line above the Daily ladder. It comes from
// profile.json, which CLAUDE.md names as the source of truth for who the owner is —
// copying it into config.yaml would make two, and the two would drift.
//
// It is baked here for the same reason the cap reset is: read at request time it
// would work locally and be silently absent on Vercel.
let grad = null;
let OWNER = null;
try {
  const p = JSON.parse(fs.readFileSync(PROFILE, "utf8"));
  const m = String(p.graduation || "").trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const i = MONTHS.indexOf(m[1].toLowerCase());
    if (i >= 0) grad = `${m[2]}-${String(i + 1).padStart(2, "0")}`;
  } else if (/^\d{4}-\d{2}(-\d{2})?$/.test(String(p.graduation || "").trim())) {
    grad = String(p.graduation).trim();
  }
  if (!grad) die(`profile.json graduation is ${JSON.stringify(p.graduation)}, which is not a month and year`);

  /* ------------------------------------------------------------- the owner
   *
   * Who runs this instance. The original was built for one person and carried
   * his name, school and class year as literals in prompts, outreach templates
   * and the alumni ranking -- the exact kind of value that survives a copy and
   * then writes someone else's cover letter. Everything personal the web side
   * needs is read here, from profile.json, and baked. Missing fields FAIL THE
   * BUILD rather than defaulting, because a default here is a wrong name on a
   * message to a stranger.
   */
  const name = String(p.name || "").trim();
  if (!name) die("profile.json has no `name`");
  const o = p.owner && typeof p.owner === "object" ? p.owner : {};
  const first = String(o.first_name || name.split(/\s+/)[0]).trim();
  const email = String(o.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    die("profile.json owner.email is missing or not an address. It is the one "
      + "address the digest can ever go to (CLAUDE.md rule 3), and it is baked "
      + "here so no request handler can change it.");
  }
  const terms = Array.isArray(o.school_search_terms)
    ? o.school_search_terms.map((t) => String(t).trim()).filter(Boolean)
    : (o.school_search_terms ? [String(o.school_search_terms).trim()] : []);
  if (!terms.length) {
    die("profile.json owner.school_search_terms is missing. It needs at least "
      + "one string (\"USC Marshall\", \"Westlake University\") -- the alumni "
      + "ranking and the LinkedIn people-search links are built from it.");
  }
  const classYear = Number(grad.slice(0, 4));
  OWNER = {
    name,
    firstName: first,
    email,
    school: String(p.school || "").trim(),
    schoolShort: String(o.school_short || terms[0]).trim(),
    schoolSearchTerms: terms,
    schoolLinkedinAlumniUrl: String(o.school_linkedin_alumni_url || "").trim() || null,
    classLabel: String(o.class_label || "student").trim(),
    degree: String(o.degree || "").trim(),
    homeCity: String(o.home_city || "").trim(),
    graduation: String(p.graduation).trim(),
    classYear,
    // The label the gate writes into jobs.start_window for a role dated for
    // the owner's class. Python builds the same string from the same field;
    // test_class_year.py and test_today.mjs both read it so the two cannot
    // drift.
    programWindow: `${classYear} program`,
  };
} catch (e) {
  if (e.code === "ENOENT") die("cannot read profile.json (copy profile.example.json and run the setup step)");
  throw e;
}

/* ------------------------------------------------------------- on track
 *
 * Targets the owner set, baked like every other value production needs. Missing
 * FAILS THE BUILD: a meter that silently defaults its targets would report
 * "0 of 0" and read as on track on a week nothing happened, which is the
 * exact inversion of what it is for.
 */
const otBlock = yamlBlock(raw, "on_track");
if (!otBlock) die("config.yaml has no on_track: block");

const apmBlock = otBlock.match(
  /^\s+applications_per_month:\s*$([\s\S]*?)(?=^\s{0,2}\S|\Z)/m);
const APPS_BY_MONTH = {};
for (const m of (apmBlock ? apmBlock[1] : otBlock)
       .matchAll(/^\s+["']?(\d{2}-\d{2})["']?:\s*(\d+)/gm)) {
  APPS_BY_MONTH[m[1]] = Number(m[2]);
}
if (!Object.keys(APPS_BY_MONTH).length) {
  die("on_track.applications_per_month parsed to nothing. Every month would show a target of zero, which reads as on track on a week with nothing in it.");
}

const otNum = (key) => {
  const m = otBlock.match(new RegExp(String.raw`^\s+${key}:\s*(\d+)`, "m"));
  if (!m) die(`on_track.${key} is missing`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) die(`on_track.${key} is ${m[1]}`);
  return n;
};

const ON_TRACK = {
  applicationsPerMonth: APPS_BY_MONTH,
  outreachPerWeek: otNum("outreach_per_week"),
  repliesPerMonth: otNum("replies_per_month"),
};


/* ------------------------------------------------------- company categories
 *
 * What KIND of company each one is, for the coloured dot beside its name.
 *
 * Baked here rather than read at request time for exactly the reason the cap
 * reset is — see the header. It could have come from the database instead, and
 * deliberately does not: `jobs.category` is a per-ROLE label, NULL on 8,362 of
 * 9,919 rows, and listCompanies takes MAX() of it, which is a lexicographic pick
 * — so Stripe reads as "vc" because four of its postings are tagged that way.
 * A company's kind is a fact about the company, and companies.yaml is where
 * facts about companies live.
 *
 * Mostly DERIVED, so it does not need maintaining: anything under a `defense_*`
 * group is defense, anything else is product, and an explicit `category:` on the
 * entry overrides both. Four entries currently carry one.
 *
 * The parser is the same shape as lib/deadlines.js and lib/companyNotes.js — a
 * few regexes over a flat block, no YAML dependency — and it splits on /\r?\n/
 * for the same reason they do: one text editor saving this file with Windows
 * line endings silently made every regex in deadlines.js match nothing, and the
 * page reported "0 windows tracked" with a green build.
 */
const CATEGORIES = new Set(["defense", "product", "consulting", "vc"]);
const BOARDS = ["greenhouse", "ashby", "lever", "rippling"];

let companiesRaw;
try {
  companiesRaw = fs.readFileSync(COMPANIES, "utf8");
} catch (e) {
  die(`cannot read companies.yaml (${e.code || e.message})`);
}

const companyCategory = {};   // board slug -> category
const firmCategory = {};      // deadlines `firm:` string -> category

/**
 * board slug -> why the owner pinned it into the outreach queue.
 *
 * A PIN IS A DECISION, NOT A SCORE, and the two must never be stored in the
 * same place. The outreach queue is otherwise ranked by fit band, which is a
 * model verdict; a pin says "a human looked at this company and decided it
 * matters anyway". Mistral is the case that forced it: seventeen AI Deployment
 * Strategist reqs, one in Palo Alto, the exact shape of the highest-fit role in
 * the corpus — and every one of them scores 28/skip because the postings ask
 * for 4+ years and a science degree. The COMPANY is worth knowing. The REQ is
 * not his. Nothing derivable from the scores can express that, so a person says
 * it, in the file where facts about companies live, with the reason attached.
 *
 * The reason is REQUIRED and is rendered on the row, so a pin can never decay
 * into an unexplained company sitting at the top of the queue.
 */
const outreachPins = {};      // board slug -> reason string

/**
 * board slug -> the words to search LinkedIn for, when the display name is a
 * bad search term.
 *
 * WHY IT IS DATA AND NOT A SPECIAL CASE. marshallPeopleSearchUrl builds a
 * KEYWORD search — "USC Marshall <company>" — so every token in the company's
 * name is a term LinkedIn has to match. "Mistral AI" therefore requires the
 * literal "AI" to appear alongside, which narrows the result set for no reason:
 * people write "Mistral" on their profile. The display name is right for the
 * page and wrong for the query, and those are simply two different strings.
 *
 * Absent, the display name is used, so this stays empty for the companies where
 * the two agree — which is nearly all of them.
 */
const searchAs = {};          // board slug -> search term

/**
 * deadlines firms with `rolling: true` -- the open-until-filled windows the
 * digest nags about daily until something is submitted (lib/consulting.js).
 * The original hardcoded three consulting firms there; a template cannot know
 * which firms the owner is chasing, so the yaml says, one flag per entry.
 */
const rollingFirms = [];

{
  let group = null;      // current top-level key
  let slug = null;       // current `- slug:` entry
  let firm = null;       // current `- firm:` entry
  const isBoard = (g) => BOARDS.some((b) => g === b || g.endsWith("_" + b));

  const settle = () => {
    // Called when an entry ends. A board entry with no explicit category takes
    // the group's default; a deadline firm has no default and must say.
    if (slug && companyCategory[slug] === undefined) {
      companyCategory[slug] = group.startsWith("defense_") ? "defense" : "product";
    }
    if (firm && firmCategory[firm] === undefined) {
      die(`deadlines entry ${JSON.stringify(firm)} has no category:. `
        + `Add one of ${[...CATEGORIES].join(", ")} to it in companies.yaml.`);
    }
    slug = null;
    firm = null;
  };

  for (const line of companiesRaw.split(/\r?\n/)) {
    const top = line.match(/^([a-z_]+):\s*$/);
    if (top) { settle(); group = top[1]; continue; }

    const s = line.match(/^\s{2}-\s+slug:\s*(\S+)/);
    if (s) { settle(); if (group && isBoard(group)) slug = s[1]; continue; }

    const f = line.match(/^\s{2}-\s+firm:\s*(.+?)\s*$/);
    if (f) { settle(); if (group === "deadlines") firm = f[1]; continue; }

    // A `- name:` entry (the `manual` block) is neither, and ends whatever the
    // previous entry was rather than inheriting its category.
    if (/^\s{2}-\s+name:/.test(line)) { settle(); continue; }

    const pin = line.match(/^\s{4}outreach_pin:\s*(.+?)\s*$/);
    if (pin && slug) { outreachPins[slug] = pin[1].replace(/^["']|["']$/g, ""); continue; }

    const sa = line.match(/^\s{4}search_as:\s*(.+?)\s*$/);
    if (sa && slug) { searchAs[slug] = sa[1].replace(/^["']|["']$/g, ""); continue; }

    const ro = line.match(/^\s{4}rolling:\s*true\s*$/);
    if (ro && firm && !rollingFirms.includes(firm)) { rollingFirms.push(firm); continue; }

    const c = line.match(/^\s{4}category:\s*(\S+)/);
    if (c) {
      if (!CATEGORIES.has(c[1])) {
        die(`companies.yaml has category: ${c[1]}, which is not one of `
          + `${[...CATEGORIES].join(", ")}. A fifth category means a fifth colour, `
          + `and the palette has four.`);
      }
      if (slug) companyCategory[slug] = c[1];
      else if (firm) firmCategory[firm] = c[1];
    }
  }
  settle();
}

// A positive assertion, so a parser that silently matched nothing cannot pass.
// Both of these have been non-empty since the day the block was written; if a
// future edit to companies.yaml breaks the shape, the BUILD says so rather than
// the app quietly rendering every dot the same colour.
if (Object.keys(companyCategory).length < 10) {
  die(`only ${Object.keys(companyCategory).length} board companies parsed out of `
    + `companies.yaml — the parser matched almost nothing, which means the file's `
    + `shape changed. Every category dot would default to product.`);
}
if (Object.keys(firmCategory).length < 10) {
  die(`only ${Object.keys(firmCategory).length} deadline firms parsed out of `
    + `companies.yaml. Forecast would show no category dots at all.`);
}

const tally = (m) => {
  const n = {};
  for (const v of Object.values(m)) n[v] = (n[v] || 0) + 1;
  return Object.entries(n).sort().map(([k, v]) => `${k} ${v}`).join(", ");
};

// Explicit "\n" joins and an explicit encoding, so the file is byte-identical
// on the Windows laptop and the Linux build machine.
/* ------------------------------------------------------------- preferences
 *
 * What the owner WANTS, kept deliberately out of profile.json: that file goes into
 * the scorer's system prompt, so a preference written there would change how
 * every future role is scored. These drive display and one optional filter and
 * must never reach a score.
 *
 * Parsed with the same small regexes the rest of this file uses rather than a
 * YAML dependency — this is four scalars and two short lists, and adding a
 * parser to read them would be a dependency for one file.
 *
 * MISSING VALUES FAIL THE BUILD, like cap_reset. A preferences block that
 * quietly defaulted would put every role in "somewhere else" or, worse, mark
 * the wrong cities preferred, and nothing on screen would say so.
 */
/**
 * The indented body of one top-level `key:` block.
 *
 * WRITTEN BY HAND BECAUSE BOTH REGEX VERSIONS WERE WRONG, in opposite ways and
 * with opposite symptoms:
 *
 *   the notifications one ended `(?=^\S|\Z)`, and `\Z` IS NOT A JAVASCRIPT
 *   ANCHOR — it matches the letter Z. The block is last in the file, so no
 *   following unindented line exists, so the lookahead never succeeded and the
 *   block never matched. Every switch then fell through to its `true` default,
 *   which is exactly why nobody noticed: config.yaml says true everywhere, so
 *   the output was right for the wrong reason. `enabled: false` would have been
 *   read as `true`.
 *
 *   the preferences one ended `[\s\S]*` with no terminator, so it swallowed
 *   every block AFTER it. Harmless only while no two blocks share a key name.
 *
 * Lines are cheap and obvious: take everything indented under the key, stop at
 * the next line that starts in column zero. Split on /\r?\n/ because a file
 * saved with Windows line endings once made every regex in deadlines.js match
 * nothing and the page report "0 windows tracked", with a green build.
 */
function yamlBlock(text, key) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => l.replace(/\s+$/, "") === `${key}:`);
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") { body.push(line); continue; }
    if (!/^\s/.test(line)) break;            // back to column zero: next block
    body.push(line);
  }
  return body.join("\n");
}

const prefBlock = yamlBlock(raw, "preferences");
if (!prefBlock) die("config.yaml has no preferences: block");

const scalar = (key) => {
  const m = prefBlock.match(new RegExp(String.raw`^\s+${key}:\s*(.+?)\s*$`, "m"));
  return m ? m[1].replace(/^['"]|['"]$/g, "") : null;
};
const list = (key) => {
  const m = prefBlock.match(new RegExp(String.raw`^\s+${key}:\s*\[(.*?)\]\s*$`, "m"));
  return m ? m[1].split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : null;
};

const gradYearRaw = scalar("graduation_year");
const gradYear = Number(gradYearRaw);
const preferredMetros = list("preferred_metros");
// `Number(null)` is 0 and `Number.isFinite(0)` is true, so a MISSING key would
// have passed a bare isFinite check and baked a graduation year of 0 into the
// bundle — every role would then read "starts before you graduate". Check the
// raw value first.
if (!gradYearRaw || !Number.isFinite(gradYear) || gradYear < 2020 || gradYear > 2040) {
  die(`preferences.graduation_year is missing or implausible (${gradYearRaw})`);
}
if (!preferredMetros || !preferredMetros.length) die("preferences.preferred_metros is missing or empty");

// A pay floor is a preference, not a scoring input (same reasoning as metros:
// it decides WITH the owner, never FOR them). Optional. `null` means no floor
// and the surfaces show nothing; a number is annual base in USD and the Inbox
// can tag roles whose published maximum falls under it. Unparseable fails the
// build, because "80k" silently read as 0 would tag every role as under the
// floor and the tag would be ignored inside a week.
const salaryRaw = scalar("salary_min");
let salaryMin = null;
if (salaryRaw && salaryRaw !== "null" && salaryRaw !== "~") {
  salaryMin = Number(String(salaryRaw).replace(/[,$_\s]/g, ""));
  if (!Number.isFinite(salaryMin) || salaryMin < 1000 || salaryMin > 2_000_000) {
    die(`preferences.salary_min is ${salaryRaw}; write an annual USD base `
      + "like 85000, or null for no floor.");
  }
}

const PREFS = {
  graduationYear: gradYear,
  canStartSeason: scalar("can_start_season"),
  preferredSeason: scalar("preferred_season"),
  preferredMetros,
  homeMetro: scalar("home_metro"),
  remoteAcceptable: scalar("remote_acceptable") !== "false",
  salaryMin,
};
if (OWNER && OWNER.classYear !== gradYear) {
  die(`profile.json graduation says ${OWNER.classYear} but config.yaml `
    + `preferences.graduation_year says ${gradYear}. One person, one year.`);
}

/* ----------------------------------------------------------- notifications
 *
 * Whether email is on, and which triggers fire. The RECIPIENT is deliberately
 * not here: it is hardcoded in lib/constants.js and must never become
 * configurable, because the moment it can vary this stops being "the tool
 * emails its owner" and becomes "the tool can email people".
 *
 * DEFAULTS TO ON, and a missing block does not fail the build the way a missing
 * cap_reset does. The difference is what a wrong default costs: a wrong
 * cap_reset silently changed a spending figure from monthly to all-time, while
 * a missing notifications block means email works as documented. Failing the
 * build over an absent optional section would be a nag with no answer.
 */
const notifyBlock = yamlBlock(raw, "notifications");
const notifyOn = (key, block) => {
  if (!block) return true;
  const m = block.match(new RegExp(String.raw`^\s+${key}:\s*(\S+)\s*$`, "m"));
  return m ? m[1] !== "false" : true;
};
/**
 * The from address, from config.yaml.
 *
 * VALIDATED HERE AND THE BUILD FAILS ON A BAD ONE. Resend rejects an
 * unverified sender with a 403, and until this session that 403 was reported
 * as a green step — so a typo here used to mean silence rather than an error.
 * Catching the obvious shapes at build time is cheaper than catching them at
 * 07:10 on a morning something else has gone wrong.
 *
 * It accepts both "a@b.com" and "Name <a@b.com>", which is what Resend accepts.
 */
const fromRaw = notifyBlock
  ? (notifyBlock.match(/^\s+from:\s*(.+?)\s*$/m) || [])[1]
  : null;
if (!fromRaw) die("config.yaml notifications: block has no `from:` address");
{
  const bare = String(fromRaw).match(/<([^>]+)>/) || [null, fromRaw];
  const addr = String(bare[1]).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    die(`notifications.from is ${JSON.stringify(fromRaw)}, which does not `
      + "contain a usable email address. Resend answers 403 for a sender it "
      + "cannot verify, and this is the cheapest place to notice.");
  }
}

/**
 * The grok_ingest block. BAKED, not read at request time.
 *
 * Same reason as every other number here: cost.js read config.yaml inside a
 * function, the tracer could not follow it, the file was absent from the
 * Vercel bundle, and a bare catch turned that into a 1970 date that made the
 * cost meter read $29.88/$5.00 in production only. A value production needs
 * cannot travel by filesystem.
 *
 * MISSING FAILS THE BUILD. A default for grok_stale_days would not be a
 * missing number, it would be a wrong one -- and the thing it governs is a
 * warning about silence, so a bad value fails toward saying nothing.
 */
function grokNumber(key, { min = 1 } = {}) {
  const m = raw.match(new RegExp("\\n\\s+" + key + ":\\s*([0-9]+)"));
  if (!m) die(`config.yaml has no parseable grok_ingest.${key}`);
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < min) {
    die(`grok_ingest.${key} is ${m[1]}, which is not a number >= ${min}.`);
  }
  return v;
}
if (!/^grok_ingest:/m.test(raw)) die("config.yaml has no grok_ingest: block");
const GROK = {
  staleDays: grokNumber("grok_stale_days"),
  maxRowsPerPaste: grokNumber("max_rows_per_paste", { min: 10 }),
  echoChars: grokNumber("echo_chars", { min: 40 }),
  extractMonthlyCap: grokNumber("extract_monthly_cap", { min: 0 }),
};

/**
 * Every company name the apply log might name, as { slug, display_name }.
 *
 * companies.yaml IS the list the spec names, and this is a SEPARATE pass over
 * the same text rather than a change to the walker above -- that walker
 * settles categories and pins, and threading a fifth output through it to get
 * a flat list of names would put this at risk of a bug in that, and that at
 * risk of a bug in this.
 *
 * NAMES ONLY, NO MATCHING LOGIC. matchEmployer() in lib/grok.js decides what
 * counts as the same company, and it does so with exact and clean-suffix
 * comparisons only. The list is data; the judgement is one function with its
 * own tests.
 *
 * A RETIRED BOARD STAYS IN THE LIST. the owner can still apply to Mach Industries
 * -- the retirement says its ATS is not machine-readable, not that the company
 * stopped existing -- and dropping it here would send every Mach application
 * to the unmatched list forever.
 */
const companyNames = [];
{
  let slug = null;
  let display = null;
  const settle = () => {
    if (slug) companyNames.push({ slug, display_name: display || slug });
    slug = null;
    display = null;
  };
  for (const line of companiesRaw.split(/\r?\n/)) {
    const s = /^\s*-\s*slug:\s*(.+?)\s*$/.exec(line);
    if (s) { settle(); slug = s[1].replace(/^["']|["']$/g, ""); continue; }
    if (/^\S/.test(line)) { settle(); continue; }
    const d = /^\s+display_name:\s*(.+?)\s*$/.exec(line);
    if (d && slug) display = d[1].replace(/^["']|["']$/g, "");
  }
  settle();
}
// A POSITIVE ASSERTION, because a walker that silently matches nothing returns
// an empty list and every application would land unmatched -- which renders as
// "the owner applied to twelve companies I have never heard of" rather than as a
// broken build.
//
// TEN, the same floor the category walker above uses, and not a number picked
// for the real file. The first version said 40, which is true of
// companies.yaml today and false of every fixture -- so it failed
// test_config.mjs, whose throwaway tree deliberately holds the minimum a
// generator should accept. A floor calibrated to production data is a floor
// that only ever fires on a test.
if (companyNames.length < 10) {
  die(`companies.yaml yielded only ${companyNames.length} company names; the `
    + "apply-log matcher needs the real list, and an empty one sends every "
    + "application to the unmatched pile.");
}

const NOTIFY = {
  from: fromRaw,
  enabled: notifyOn("enabled", notifyBlock),
  // IMPORTED, NOT RETYPED. This was a second copy of the trigger list, and a
  // trigger added to notify.js but not here was silently dropped from the baked
  // config — the code knew about it, `on()` defaulted it to true, and
  // config.yaml could not switch it off. test_notify.mjs asserts the two lists
  // match, which is what caught it; importing the one definition means there is
  // nothing left to keep in step. notify.js is pure — no `node:` imports — so
  // it is safe to pull into a build script.
  triggers: Object.fromEntries(
    TRIGGERS.map((k) => [k, notifyOn(k, notifyBlock)])),
};

fs.writeFileSync(
  DEST,
  [
    "/* GENERATED by lib/genconfig.mjs from config.yaml, profile.json and",
    " * companies.yaml. Do not edit, do not commit. Regenerated by `npm run build`",
    " * and `npm run dev`; see genconfig.mjs for why none of this is read from disk",
    " * at request time. */",
    `export const CAP_RESET = ${JSON.stringify(reset[1])};`,
    `export const MONTHLY_CAP = ${Number(cap[1])};`,
    `export const TRANSFER_ALLOWANCE_BYTES = ${ALLOWANCE_GB * 1e9};`,
    `export const TRANSFER_WARN_AT = ${WARN_FRACTION};`,
    `export const ON_TRACK = ${JSON.stringify(ON_TRACK, null, 2)};`,
    `export const GRADUATION = ${JSON.stringify(grad)};`,
    `export const OWNER = ${JSON.stringify(OWNER, null, 2)};`,
    `export const NOTIFY_TO = ${JSON.stringify(OWNER.email)};`,
    `export const CLASS_YEAR = ${OWNER.classYear};`,
    `export const PROGRAM_WINDOW = ${JSON.stringify(OWNER.programWindow)};`,
    `export const COMPANY_CATEGORY = ${JSON.stringify(companyCategory, null, 2)};`,
    `export const FIRM_CATEGORY = ${JSON.stringify(firmCategory, null, 2)};`,
    `export const OUTREACH_PINS = ${JSON.stringify(outreachPins, null, 2)};`,
    `export const SEARCH_AS = ${JSON.stringify(searchAs, null, 2)};`,
    `export const ROLLING_FIRMS = ${JSON.stringify(rollingFirms, null, 2)};`,
    `export const PREFS = ${JSON.stringify(PREFS, null, 2)};`,
    `export const NOTIFY = ${JSON.stringify(NOTIFY, null, 2)};`,
    `export const GROK = ${JSON.stringify(GROK, null, 2)};`,
    `export const COMPANY_NAMES = ${JSON.stringify(companyNames, null, 2)};`,
    "",
  ].join("\n"),
  { encoding: "utf8" },
);

console.log(`genconfig: cap_reset ${reset[1]}, monthly_cap ${Number(cap[1])}, `
  + `graduation ${grad} -> lib/config.generated.js`);
console.log(`genconfig: owner ${OWNER.name} (${OWNER.schoolShort}, class of ${OWNER.classYear}), `
  + `digest to ${OWNER.email}`);
console.log(`genconfig: ${companyNames.length} company names for the apply-log matcher`);
console.log(`genconfig: grok stale after ${GROK.staleDays}d, max ${GROK.maxRowsPerPaste} rows/paste`);
console.log(`genconfig: neon allowance ${ALLOWANCE_GB} GB, warn at ${Math.round(WARN_FRACTION * 100)}%`);
console.log(`genconfig: on-track targets ${Object.entries(ON_TRACK.applicationsPerMonth).map(([k, v]) => `${k}:${v}`).join(' ')} apps, ${ON_TRACK.outreachPerWeek}/wk outreach, ${ON_TRACK.repliesPerMonth}/mo replies`);
console.log(`genconfig: prefers ${PREFS.preferredSeason} ${PREFS.graduationYear}, `
  + `metros ${PREFS.preferredMetros.join("/")}, home ${PREFS.homeMetro}`);
console.log(`genconfig: notifications ${NOTIFY.enabled ? "on" : "OFF"}, `
  + `${Object.values(NOTIFY.triggers).filter(Boolean).length} of `
  + `${Object.keys(NOTIFY.triggers).length} triggers enabled, `
  + `from ${NOTIFY.from}`);
console.log(`genconfig: ${Object.keys(outreachPins).length} outreach pin(s)`
  + (Object.keys(outreachPins).length ? `: ${Object.keys(outreachPins).join(", ")}` : "")
  + `, ${Object.keys(searchAs).length} search_as override(s)`
  + (Object.keys(searchAs).length
    ? `: ${Object.entries(searchAs).map(([k, v]) => `${k}->"${v}"`).join(", ")}` : ""));
console.log(`genconfig: ${Object.keys(companyCategory).length} board companies `
  + `(${tally(companyCategory)}), ${Object.keys(firmCategory).length} deadline firms `
  + `(${tally(firmCategory)})`);
