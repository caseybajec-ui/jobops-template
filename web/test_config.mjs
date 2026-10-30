/**
 * Tests for the build-time config bake. Run: node test_config.mjs
 *
 * The bug this guards: the deployed cost meter read **$29.88 / $5.00 OVER CAP**
 * in red on every page while the same code read $3.17 locally. cost.js was
 * reading ../config.yaml at request time, that file is not in the Vercel bundle,
 * a bare `catch {}` swallowed the ENOENT, and the "1970-01-01" fallback made
 * every batch ever submitted count as this month's spend.
 *
 * So there are two things worth asserting, and the second matters more:
 *
 *   1. the baked value matches config.yaml — a stale generated file is the
 *      obvious new failure mode this design introduces;
 *   2. the generator REFUSES when it cannot read config.yaml, exiting non-zero
 *      and writing nothing. A generator that quietly emits a default would
 *      reproduce the original bug one layer down, and a check that has only ever
 *      been run against a working config cannot tell you which one it is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..");

let pass = 0;
const fails = [];
const is = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? pass++
    : fails.push(`${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
const ok = (cond, what) => is(!!cond, true, what);

// ------------------------------------------------ 1. the baked value is right
const yaml = fs.readFileSync(path.join(REPO, "config.yaml"), "utf8");
const wantReset = yaml.match(/cap_reset:\s*'?([0-9T:+\-]{10,})'?/)[1];
const wantCap = Number(yaml.match(/monthly_cap:\s*([0-9]+(?:\.[0-9]+)?)/)[1]);

const { CAP_RESET, MONTHLY_CAP, GRADUATION, OWNER, CLASS_YEAR, PROGRAM_WINDOW, NOTIFY_TO } =
  await import("./lib/config.generated.js");
is(CAP_RESET, wantReset, "the baked cap_reset matches config.yaml");
is(MONTHLY_CAP, wantCap, "the baked monthly_cap matches config.yaml");

// Graduation comes from profile.json, which CLAUDE.md names as the source of
// truth for who the owner is. Baked for the same reason: read at request time
// it works locally and is silently absent on Vercel.
//
// COMPARED AGAINST THE FILE, NOT A LITERAL. The original asserted one person's
// year here; a template's profile.json is whoever copied it, so the test
// derives the expectation from the same file the generator read.
const profile = JSON.parse(fs.readFileSync(path.join(REPO, "profile.json"), "utf8"));
const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
                "august", "september", "october", "november", "december"];
const gm = String(profile.graduation).trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
ok(!!gm, "profile.json graduation is a month and a year");
const wantGrad = gm && `${gm[2]}-${String(MONTHS.indexOf(gm[1].toLowerCase()) + 1).padStart(2, "0")}`;
is(GRADUATION, wantGrad, "the baked graduation is the month from profile.json");

// THE OWNER BLOCK, baked from the same file. Every personal fact the web side
// uses -- name, school terms, class year, the digest address -- comes from
// here and from nowhere else, so each is checked against its source.
is(OWNER.name, String(profile.name).trim(), "the baked owner name is profile.json name");
is(OWNER.email, String(profile.owner.email).trim(), "the baked owner email is profile.json owner.email");
is(NOTIFY_TO, OWNER.email, "NOTIFY_TO is the owner's email and nothing else");
is(OWNER.schoolSearchTerms, profile.owner.school_search_terms,
   "the school search terms are baked verbatim");
is(CLASS_YEAR, Number(wantGrad.slice(0, 4)), "the class year is the graduation year");
is(PROGRAM_WINDOW, `${CLASS_YEAR} program`,
   "the start_window label is built from the class year, the way the gate builds it");

// It has to be a real date, not the sentinel that caused the bug. "1970-01-01"
// is earlier than every batch ever submitted, which is exactly how the lifetime
// total came to be displayed as this month's spend.
ok(CAP_RESET >= "2020", "cap_reset is a real date, not the 1970 fallback");

// --------------------------------- 2. cost.js does not read a file at request
// The distinction that made this bug production-only is far too fine to leave
// load-bearing: five other modules read repo-root files the same way and work,
// because the tracer can evaluate a module-level const. cost.js built the path
// inside a function, so config.yaml was never bundled. Assert the read is gone
// rather than trusting that nobody puts it back.
const costSrc = fs.readFileSync(path.join(here, "lib", "cost.js"), "utf8");
is(/readFileSync|node:fs/.test(costSrc), false,
   "cost.js reads no file at request time — the value is baked in at build time");

// ---- the same claim, EXECUTED --------------------------------------------
//
// The assertion above is a regex over one file, and it only ever sees that one
// file. cost.js can reach the filesystem without containing either string, by
// calling something that does — readEnv() in lib/pgcheck.mjs is exactly the
// helper someone would reach for, and it reads ../config.yaml's neighbour off
// disk. The grep stays green and the production-only bug is back.
//
// Structure verified, value unverified. So: instrument fs, compute the meter for
// real, and require that it touched NO file at all.
{
  const realRead = fs.readFileSync;
  const realReadFile = fs.promises?.readFile;
  let reads = [];
  const watch = () => {
    fs.readFileSync = (p, ...rest) => { reads.push(String(p)); return realRead(p, ...rest); };
    if (fs.promises && realReadFile) {
      fs.promises.readFile = (p, ...rest) => {
        reads.push(String(p)); return realReadFile.call(fs.promises, p, ...rest);
      };
    }
  };
  const restore = () => {
    fs.readFileSync = realRead;
    if (fs.promises && realReadFile) fs.promises.readFile = realReadFile;
  };

  try {
    watch();
    // THE PROBE CAN SEE A READ. Without this control the whole section passes
    // when the instrumentation is broken, which is the same nothing-measured
    // failure it exists to catch.
    realRead(path.join(REPO, "config.yaml"), "utf8");     // not counted: bypasses the wrapper
    fs.readFileSync(path.join(REPO, "config.yaml"), "utf8");
    ok(reads.length === 1, "the filesystem probe registers a read when one happens");

    const cost = await import("./lib/cost.js");
    reads = [];                       // whatever the import did is not request time
    let threw = null;
    try {
      await cost.monthToDate();
    } catch (e) {
      threw = e;                      // a database outage is not this test's subject
    }
    ok(reads.length === 0,
       "computing the cost meter read NO file — the config is baked in\n"
       + `      files read: ${reads.join(", ") || "(none)"}`);
    is(cost.MONTHLY_CAP, wantCap, "and the cap it reports at runtime is config.yaml's");
    // Said out loud rather than hidden: if the database was unreachable the call
    // returned early, and a read that would have happened later did not happen.
    if (threw) {
      console.log(`  note: monthToDate() threw (${String(threw.message).slice(0, 60)}) — `
                + "the no-read assertion still holds for the path that ran.");
    }
  } finally {
    restore();
  }
}

// ------------------------------------------- 3. the generator refuses to guess
// Run genconfig against a throwaway tree, so the real config.yaml is untouched.
// It resolves its source relative to its OWN location, so the tree has to have
// the same shape: <root>/config.yaml and <root>/web/lib/genconfig.mjs.
// A FICTIONAL OWNER, with the owner block genconfig now requires. The year
// has to agree with the fixture config.yaml's graduation_year below, because
// the generator refuses a profile and a config that disagree -- so it is one
// constant, used by both, and deliberately not any real owner's year.
const FIXTURE_YEAR = 2029;
const GOOD_PROFILE = JSON.stringify({
  name: "Jordan Reyes", graduation: `May ${FIXTURE_YEAR}`,
  owner: { email: "jordan.reyes@example.edu",
           school_search_terms: ["Westlake Hayden", "Westlake University"] },
});

/* A companies.yaml big enough to clear the generator's own "did I parse
 * anything at all" floors: at least 10 board companies and 10 deadline firms.
 * Those floors exist because a parser that silently matched nothing would
 * render every category dot in the app the same colour and still exit 0. */
const GOOD_COMPANIES = [
  "greenhouse:",
  ...Array.from({ length: 10 }, (_, i) =>
    ["  - slug: co" + i, "    display_name: Co " + i, "    tier: 1"].join("\n")),
  "defense_ashby:",
  ["  - slug: adefense", "    display_name: A Defense Co", "    tier: 1"].join("\n"),
  ["  - slug: avc", "    category: vc", "    display_name: A VC", "    tier: 2"].join("\n"),
  "deadlines:",
  ...Array.from({ length: 10 }, (_, i) =>
    ["  - firm: Firm " + i, "    category: consulting",
     "    program: P" + i, "    status: open"].join("\n")),
  "",
].join("\n");

function runGen(configText, profileText = GOOD_PROFILE, companiesText = GOOD_COMPANIES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobops-genconfig-"));
  const lib = path.join(root, "web", "lib");
  fs.mkdirSync(lib, { recursive: true });
  // GENCONFIG'S SIBLINGS COME TOO. It imports TRIGGERS from notify.js so the
  // list of triggers exists once rather than twice — the copy that used to live
  // in genconfig went stale the moment a trigger was added, and the baked
  // config silently lacked the key.
  //
  // Copying the whole lib rather than naming notify.js and its imports: the
  // dependency chain is not this test's business, and a test that has to be
  // edited every time an import is added is one that gets edited wrongly.
  //
  // config.generated.js IS EXCLUDED, deliberately. It is a real (gitignored)
  // file in lib/, and copying it would make the `wrote` check below true before
  // genconfig had run — so every "it refuses to guess" assertion would pass
  // against a file the generator never produced.
  for (const f of fs.readdirSync(path.join(here, "lib"))) {
    if (!f.endsWith(".js") && !f.endsWith(".mjs")) continue;
    if (f === "config.generated.js") continue;
    fs.copyFileSync(path.join(here, "lib", f), path.join(lib, f));
  }
  if (profileText !== null) fs.writeFileSync(path.join(root, "profile.json"), profileText);
  if (configText !== null) fs.writeFileSync(path.join(root, "config.yaml"), configText);
  if (companiesText !== null) fs.writeFileSync(path.join(root, "companies.yaml"), companiesText);
  let code = 0;
  try {
    execFileSync(process.execPath, [path.join(lib, "genconfig.mjs")], { stdio: "pipe" });
  } catch (e) {
    code = e.status ?? 1;
  }
  const wrote = fs.existsSync(path.join(lib, "config.generated.js"));
  fs.rmSync(root, { recursive: true, force: true });
  return { code, wrote };
}

// The positive control FIRST. Without it, all three failures below could be the
// harness being broken rather than the generator being strict — a test that has
// only ever failed proves as little as one that has only ever passed.
/* A well-formed config.yaml needs every block the generator hard-fails on, and
 * that list grew when preferences moved in here. They live in config.yaml
 * rather than profile.json ON PURPOSE: profile.json goes into the scorer's
 * system prompt, so a location or start preference written there would change
 * how every future role is scored. */
const GOOD_CONFIG = [
  "cost:",
  "  cap_reset: '2026-08-25T04:32:47+00:00'",
  "  monthly_cap: 5.00",
  // The Neon plan. Required since the allowance stopped being a
  // hardcoded 5 GB in lib/transfer.js -- a constant that survived the
  // upgrade to Launch and made every percentage wrong by 100x.
  "database:",
  "  transfer_allowance_gb: 500",
  "  transfer_warn_at: 0.70",
  // Targets for the on-track line. Required, because a meter that
  // silently defaulted them would report "0 of 0" and read as ON TRACK
  // on a week nothing happened -- the exact inversion of its job.
  "on_track:",
  "  applications_per_month:",
  "    \"09-11\": 3",
  "    \"04-12\": 2",
  "  outreach_per_week: 5",
  "  replies_per_month: 2",
  // The apply-log ingest. Required for the same reason as every block above
  // it: grok_stale_days governs a warning about SILENCE, so a quiet default
  // would not be a missing number but a wrong one, and it would fail in the
  // direction of saying nothing.
  "grok_ingest:",
  "  grok_stale_days: 3",
  "  max_rows_per_paste: 200",
  "  echo_chars: 400",
  "  extract_monthly_cap: 5",
  "preferences:",
  `  graduation_year: ${FIXTURE_YEAR}`,
  "  can_start_season: summer",
  "  preferred_season: fall",
  "  preferred_metros: [nyc, sf]",
  "  home_metro: la",
  "  remote_acceptable: true",
  // The notifications block, which genconfig now hard-fails without. Adding a
  // required key SHOULD break this fixture — that is the fixture doing its job,
  // and it is how the missing `from:` was caught here rather than at 07:10.
  "notifications:",
  "  enabled: true",
  "  from: JobOps <jobops@example.com>",
  "  triggers:",
  "    pipeline_failure: true",
  "",
].join("\n");

const good = runGen(GOOD_CONFIG);
is(good, { code: 0, wrote: true }, "a well-formed config.yaml generates the module");

/* The new hard failures. A preferences block that quietly defaulted would mark
 * the wrong cities preferred, or bake a graduation year of 0 and report every
 * role as starting before he graduates — with nothing on screen saying so.
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, which is exactly how a
 * missing key passes a careless check; it did, until this test was written. */
is(runGen(GOOD_CONFIG.replace("preferences:", "prefs:")),
   { code: 1, wrote: false }, "no preferences block at all is refused");

/* THE NOTIFICATIONS BLOCK, and why it is checked this hard.
 *
 * Its parser matched NOTHING for a whole session and nobody noticed, because
 * every switch fell through to a `true` default and config.yaml happens to say
 * true everywhere — so the output was right for the wrong reason, and
 * `enabled: false` would have been silently ignored. The parser ended
 * `(?=^\S|\Z)`, and `\Z` is not a JavaScript anchor; it matches the letter Z.
 *
 * So a missing block now fails the build, and a bad from address fails it too:
 * Resend answers 403 for a sender it cannot verify, and this is the cheapest
 * place to find that out. */
is(runGen(GOOD_CONFIG.replace("notifications:", "notifs:")),
   { code: 1, wrote: false }, "no notifications block at all is refused");
is(runGen(GOOD_CONFIG.replace("  from: JobOps <jobops@example.com>\n", "")),
   { code: 1, wrote: false }, "a missing from address is refused");
is(runGen(GOOD_CONFIG.replace("JobOps <jobops@example.com>", "not-an-address")),
   { code: 1, wrote: false }, "and one that is not an address is refused");
is(runGen(GOOD_CONFIG.replace("JobOps <jobops@example.com>", "plain@example.com")),
   { code: 0, wrote: true }, "a bare address with no display name is fine");
is(runGen(GOOD_CONFIG.replace(`  graduation_year: ${FIXTURE_YEAR}\n`, "")),
   { code: 1, wrote: false }, "a missing graduation_year is refused, not defaulted to 0");

/* THE NEON ALLOWANCE. Every percentage in the digest divides by it, so a
 * default would not be a missing number, it would be a WRONG one -- which is
 * how the hardcoded 5 GB survived the move to Launch. */
is(runGen(GOOD_CONFIG.replace("  transfer_allowance_gb: 500\n", "")),
   { code: 1, wrote: false }, "a missing transfer_allowance_gb is refused");
is(runGen(GOOD_CONFIG.replace("transfer_allowance_gb: 500", "transfer_allowance_gb: 0")),
   { code: 1, wrote: false }, "an allowance of zero is refused, not divided by");
/* 0.70 and 70 are both plausible things to type and differ by 100x. Written as
 * 70 the threshold would never fire, turning a false alarm into silence. */
is(runGen(GOOD_CONFIG.replace("transfer_warn_at: 0.70", "transfer_warn_at: 70")),
   { code: 1, wrote: false }, "a warn threshold of 70 (not 0.70) is refused");
is(runGen(GOOD_CONFIG.replace("  transfer_warn_at: 0.70\n", "")),
   { code: 1, wrote: false }, "a missing transfer_warn_at is refused");

/* THE ON-TRACK TARGETS. A default here would not be a missing number, it would
 * be a WRONG one: every target becomes zero, every week reads as met, and the
 * one line that measures what the owner DID says they are fine. */
is(runGen(GOOD_CONFIG.replace("on_track:", "targets:")),
   { code: 1, wrote: false }, "a missing on_track block is refused");
is(runGen(GOOD_CONFIG.replace("  outreach_per_week: 5\n", "")),
   { code: 1, wrote: false }, "a missing outreach_per_week is refused");
is(runGen(GOOD_CONFIG.replace("outreach_per_week: 5", "outreach_per_week: 0")),
   { code: 1, wrote: false }, "a target of zero is refused, not treated as met");
is(runGen(GOOD_CONFIG.replace("    \"09-11\": 3\n    \"04-12\": 2\n", "")),
   { code: 1, wrote: false },
   "an empty applications_per_month is refused rather than making every month 0");
is(runGen(GOOD_CONFIG.replace("  preferred_metros: [nyc, sf]", "  preferred_metros: []")),
   { code: 1, wrote: false }, "an empty preferred_metros is refused");

is(runGen(null), { code: 1, wrote: false },
   "a MISSING config.yaml fails the build and writes nothing");
is(runGen("cost:\n  monthly_cap: 5.00\n"), { code: 1, wrote: false },
   "a config.yaml with no cap_reset fails the build and writes nothing");
is(runGen("cost:\n  cap_reset: '2026-08-25T04:32:47+00:00'\n"), { code: 1, wrote: false },
   "a config.yaml with no monthly_cap fails the build and writes nothing");

// GOOD_CONFIG is declared once, further up, and now carries the preferences
// block the generator requires. The cost-only version that used to be redefined
// here no longer generates at all.
is(runGen(GOOD_CONFIG, null), { code: 1, wrote: false },
   "a MISSING profile.json fails the build and writes nothing");
const withProfile = (patch) => JSON.stringify({ ...JSON.parse(GOOD_PROFILE), ...patch });
is(runGen(GOOD_CONFIG, withProfile({ graduation: undefined })), { code: 1, wrote: false },
   "a profile.json with no graduation fails the build");
is(runGen(GOOD_CONFIG, withProfile({ graduation: "next spring" })), { code: 1, wrote: false },
   "a graduation that is not a month and year fails rather than being guessed at");
is(runGen(GOOD_CONFIG, withProfile({ graduation: `Maybe ${FIXTURE_YEAR}` })), { code: 1, wrote: false },
   "and an unrecognised month name fails too, rather than silently becoming month 0");

// THE OWNER BLOCK IS REQUIRED. A default here is not a missing value, it is a
// wrong name on a message to a stranger, or a digest to nobody.
is(runGen(GOOD_CONFIG, withProfile({ name: "" })), { code: 1, wrote: false },
   "a profile.json with no name fails the build");
is(runGen(GOOD_CONFIG, withProfile({ owner: { school_search_terms: ["X U"] } })),
   { code: 1, wrote: false }, "a missing owner.email fails the build");
is(runGen(GOOD_CONFIG, withProfile({ owner: { email: "not-an-address", school_search_terms: ["X U"] } })),
   { code: 1, wrote: false }, "an owner.email that is not an address fails the build");
is(runGen(GOOD_CONFIG, withProfile({ owner: { email: "a@b.co" } })), { code: 1, wrote: false },
   "a missing owner.school_search_terms fails the build -- the alumni ranking would match nothing");
is(runGen(GOOD_CONFIG, withProfile({ graduation: `May ${FIXTURE_YEAR + 1}` })), { code: 1, wrote: false },
   "a profile year that disagrees with config.yaml graduation_year fails: one person, one year");

// ------------------------------------- 4. the company categories, same rules
//
// These drive the coloured dot beside every company name, and they are baked
// here for exactly the reason cap_reset is: read at request time they work
// locally and are silently absent on Vercel. So the same discipline applies —
// a source the generator cannot read or cannot understand FAILS THE BUILD,
// rather than falling back to a default that changes what the page claims.
is(runGen(GOOD_CONFIG, GOOD_PROFILE, null), { code: 1, wrote: false },
   "a MISSING companies.yaml fails the build — every category dot would silently default to product");

is(runGen(GOOD_CONFIG, GOOD_PROFILE, "greenhouse:\n  - slug: only-one\n    tier: 1\n"),
   { code: 1, wrote: false },
   "a companies.yaml the parser barely matches fails, rather than shipping one category out of forty");

// A deadline firm belongs to no ATS group, so it has no derivable default and
// must SAY. Colouring McKinsey as a product company would be a wrong fact
// rendered confidently, which is the failure this whole file exists to prevent.
is(runGen(GOOD_CONFIG, GOOD_PROFILE,
          GOOD_COMPANIES.replace("  - firm: Firm 0\n    category: consulting", "  - firm: Firm 0")),
   { code: 1, wrote: false },
   "a deadlines entry with no category fails the build rather than being guessed at");

// A fifth category means a fifth colour, and the palette has four.
is(runGen(GOOD_CONFIG, GOOD_PROFILE, GOOD_COMPANIES.replace("    category: vc", "    category: fintech")),
   { code: 1, wrote: false },
   "a category outside the closed set of four fails the build");

// ----------------------------------------------------------------------------
if (fails.length) {
  console.log(`\n${fails.length} FAILED of ${pass + fails.length}\n`);
  for (const f of fails) console.log(`  ${f}\n`);
  process.exit(1);
}
console.log(`${pass}/${pass} passed`);
