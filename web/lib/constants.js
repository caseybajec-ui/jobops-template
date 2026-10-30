/**
 * Constants that are facts about the USER, not about a feature.
 *
 * Everything else already lives beside the rule that uses it — the follow-up
 * cadence in people.js, the nudge horizon in lifecycle.js, the window horizon in
 * display.js — and those are REUSED rather than duplicated here.
 *
 * WHO THE OWNER IS COMES FROM profile.json, BAKED AT BUILD TIME. The original
 * carried one person's class year, school and email as literals in this file.
 * A template cannot: those values are read by lib/genconfig.mjs from
 * profile.json (`name`, `graduation`, and the `owner` block) and exported from
 * lib/config.generated.js, which the build regenerates and never commits. This
 * file re-exports them under the names the rest of the app already uses, so no
 * call site changed and nothing personal lives in a tracked source file.
 */
import { OWNER, CLASS_YEAR, NOTIFY_TO as BAKED_NOTIFY_TO } from "./config.generated.js";

/**
 * The timezone every "today" is computed in.
 *
 * NOT the server's. Vercel runs in UTC, which flips the date at 5pm Pacific —
 * so the day's scheduled task would change in the middle of the afternoon, and
 * the Monday retro would fire on Sunday evening. Every date boundary in this
 * app goes through this. Set it to the owner's zone in config.yaml
 * (preferences.timezone) if it is ever made configurable; today it is a
 * constant on purpose, because every test fixture assumes one zone.
 */
export const USER_TZ = "America/Los_Angeles";

/** The class the owner graduates with. Drives which dated roles are actionable. */
export const USER_CLASS_YEAR = CLASS_YEAR;

/** The owner, for templates and labels: first name, school, class label. */
export { OWNER };

/**
 * The school-wide alumni search on LinkedIn, ready for a company name.
 *
 * A LINK THE USER CLICKS. Nothing in this repository fetches it: CLAUDE.md
 * rule 2 forbids scraping LinkedIn, and their terms prohibit it. This builds a
 * URL and opens it in a tab; what happens after that is a person reading a page
 * in their own browser, signed in as themselves.
 *
 * profile.json owner.school_linkedin_alumni_url is the school's /people/ page.
 * When it is absent, the per-company search below is the only link offered.
 * If LinkedIn ever repoints the school slug the link lands on a 404 and the
 * fix is that one field.
 */
export const SCHOOL_LINKEDIN_ALUMNI = OWNER.schoolLinkedinAlumniUrl;

/**
 * LINKEDIN SCHOOL /people/ PAGES IGNORE ?keywords=. Do not rebuild that link.
 *
 * Found by a human click, 2026-09-03. Three school-scoped URLs of the form
 * /school/<slug>/people/?keywords=<company> all loaded fine — no 404, which
 * is why a fetch would never have caught it — and every one landed on the
 * SAME unfiltered page of 51,107 alumni with an empty search box. The page's
 * alumni filter runs on the client after load, so no query parameter can
 * drive it.
 *
 * So the per-company link is a plain PEOPLE SEARCH seeded with the school's
 * first search term and the company, and the school page is offered beside it
 * as exactly what it is: the unfiltered alumni list, filtered by hand once
 * open. A KEYWORD MATCH, not an alumni filter — the label on the page says so.
 */
export function schoolPeopleSearchUrl(company) {
  return "https://www.linkedin.com/search/results/people/?keywords="
    + encodeURIComponent(`${OWNER.schoolSearchTerms[0]} ${company || ""}`.trim());
}

/** The words the per-company search is seeded with, for labels. */
export const SCHOOL_SEARCH_PREFIX = OWNER.schoolSearchTerms[0];

/**
 * THE ONLY ADDRESS THIS TOOL WILL EVER EMAIL.
 *
 * Baked from profile.json owner.email at build time, exported as a constant,
 * and used by exactly one call site. There is no recipient field anywhere in
 * this codebase, no CC, no BCC, and no way to pass an address in — the sender
 * does not accept one as an argument, and test_notify.mjs asserts that the
 * address it uses is this constant.
 *
 * WHY IT IS WRITTEN THIS WAY. CLAUDE.md rule 3: the tool never sends anything
 * to another human. Every message to a real person is drafted, approved by
 * the owner, and sent by the owner from their own mail client — that rule is
 * enforced by construction, because no code exists that could send one.
 *
 * This is the single exception and it is not really one: it is the tool
 * emailing its OWNER about their own data. It stays safe only while the
 * address cannot vary at request time, so it must never become a column, a
 * setting, a parameter, or a field on a form. Baking it from the profile at
 * build time keeps that property: changing it means editing profile.json and
 * redeploying, never a request. If a future feature seems to need a second
 * recipient, that feature is wrong.
 */
export const NOTIFY_TO = BAKED_NOTIFY_TO;

/**
 * Who it comes from — LAST RESORT ONLY.
 *
 * The real value lives in config.yaml under `notifications.from` and is baked
 * into lib/config.generated.js at build time. This is what the sender falls
 * back to if that is somehow absent, and it exists so a missing config cannot
 * produce an email with no From header at all.
 *
 * NOTE THE ASYMMETRY, because it is the whole design. The FROM address is a
 * return label and is configurable. The TO address is a rule and is not: it is
 * NOTIFY_TO above, baked, and the send function accepts no recipient argument
 * at all.
 */
export const NOTIFY_FROM_FALLBACK = "JobOps <onboarding@resend.dev>";
