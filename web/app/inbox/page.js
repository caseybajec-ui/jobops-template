import {
  listJobs, facets, payShape, bandCounts, sortOrderSentence,
  groupRoles, actionState, actionDates, lastVisit, capPerCompany,
} from "@/lib/db";
import Inbox from "../Inbox";
import { CategoryLegend } from "../Palette";
import { categoryOfCompany } from "@/lib/palette";
import { referralCompanies } from "@/lib/contacts";
import { roleLifecycle, hiddenRoles } from "@/lib/db";
import { contactsByCompany } from "@/lib/contacts";
import { placeFor, whereThese } from "@/lib/geo";
import { PREFS } from "@/lib/config.generated";
import { HANDLED } from "@/lib/lifecycle";
import { resolved } from "@/lib/assert";

export const dynamic = "force-dynamic"; // the CLI writes jobs.db behind us

export default async function Page({ searchParams }) {
  const sp = await searchParams;
  const filters = {
    // 55+ by default. 353 of the 427 grouped rows are Weak, so the unfiltered
    // page was mostly noise and Daily now answers "what should I do". The
    // Inbox's honest job is the long tail for when Daily is wrong, so the tail
    // is one click away rather than the first thing on screen.
    minScore: Number(sp.min ?? 55),
    category: sp.cat || null,
    company: sp.co || null,
    level: sp.level || null,
    sort: sp.sort || "fit",
    payKnown: sp.pay === "1",
    minPay: Number(sp.minpay || 0),
    // Set only by the pay sentence at the foot of Daily, which links its own
    // number here. No checkbox: it answers one question and is not a preference.
    maxPay: Number(sp.maxpay || 0),
    showExperienced: sp.exp === "1",
    showOtherYears: sp.yr === "1",
    showClearance: sp.clr === "1",
    showHidden: sp.hidden === "1",
    // New York, the Bay Area, or remote. A FILTER, never a reranking — see the
    // note on the checkbox in Inbox.js.
    nearMe: sp.near === "1",
    curatedOnly: sp.worth === "1",
    // Roles that have been dealt with — applied, rejected, ghosted and every
    // stage between — leave the default view. The inbox is a list of
    // decisions still to make, and a role you already applied to is not one.
    // Nothing is deleted and the toggle brings them straight back.
    showHandled: sp.handled === "1",
    // Capped unless explicitly switched off. Without a cap, Palantir alone was
    // 17 of the top 25, which measures board size rather than fit.
    //
    // The number is settable because Daily caps at 2 and links here saying "See
    // all 26" — with a hardcoded 3 that link landed on 30 rows. A link that
    // states a count has to deliver that count or the count is decoration.
    cap: sp.cap === "0" ? 0 : (Number(sp.cap) > 0 ? Number(sp.cap) : 3),
  };

  // Sort criteria 1 and 2 are live. Criterion 6 waits for competitiveness
  // labels and is skipped rather than guessed — the footer says which are on.
  const [state, since, referrals, lifecycle] = await Promise.all([
    actionState(), lastVisit(), referralCompanies(), roleLifecycle(),
  ]);
  // How many people he knows at each company, which is what decides whether a
  // row says "Find a person" or "Watch". Read once per request and handed down,
  // rather than each row asking — the counts are the same for every row and a
  // per-row lookup would be the same query fifty times.
  const contactCounts = Object.fromEntries(
    [...(await contactsByCompany())].map(([co, c]) => [co, c.n || 0]));

  resolved(state, "actionState");
  resolved(since, "lastVisit");
  const sortCtx = { saved: state.saved, newSince: since };

  // Group by location BEFORE capping, so a role posted in six cities does not
  // consume six of the per-company slots.
  const grouped = groupRoles(resolved(await listJobs({ ...filters, sortCtx, cap: 0, limit: 2000 }), "listJobs"))
    .filter((r) => !filters.level || r.entry_level === filters.level);

  const handledKeys = new Set(
    [...lifecycle].filter(([, s]) => s && HANDLED.has(s.status)).map(([k]) => k));

  const visible = (filters.showHidden
    ? grouped
    : grouped.filter((r) => !state.hidden.has(r.groupKey))
  ).filter((r) => filters.showHandled || !handledKeys.has(r.groupKey))
    // Applied AFTER the hidden/handled filters and BEFORE the cap, so a role
    // outside the preferred metros does not consume one of its company's slots
    // and silently push a New York role off the page.
    .filter((r) => !filters.nearMe || placeFor(r, PREFS).preferred);

  // One implementation of the cap, shared with Daily, so the two pages cannot
  // disagree about how many roles a company contributes.
  const jobs = capPerCompany(visible, filters.cap).slice(0, 200);

  // The footer summary describes the ROWS ON SCREEN, not the wider set. Two
  // numbers on one page must come from one population, and a breakdown of 200
  // roles under a list of 60 would invite exactly the wrong conclusion about
  // how much of the board is in New York.
  const where = whereThese(jobs, PREFS);

  const [bands, pay, facetData, appliedDates] = await Promise.all([
    bandCounts(), payShape(), facets(), actionDates("applied"),
  ]);
  resolved(bands, "bandCounts");
  resolved(pay, "payShape");
  resolved(facetData, "facets");

  return (
    <>
      <Inbox
        jobs={jobs}
        facets={facetData}
        filters={filters}
        actions={{
          saved: [...state.saved],
          hidden: [...state.hidden],
          applied: [...state.applied],
        }}
        referrals={[...referrals]}
        where={where}
        contactCounts={contactCounts}
        hiddenCycle={await hiddenRoles()}
        lifecycle={Object.fromEntries(lifecycle)}
        handledCount={handledKeys.size}
        appliedAt={Object.fromEntries(appliedDates)}
        newSince={since}
        hiddenCount={state.hidden.size}
      />
      <div className="filters foot">
        <span className="faint">
          {bands.total} roles a new grad can get · {bands.strongPlus} strong or
          better · {pay.under90} publish pay under $90K · pay is base only.{" "}
          {sortOrderSentence(sortCtx)}
        </span>
      </div>
      {/* All four categories, always. It used to narrow to the ones on this
          page, computed from the FILTERED rows — so the key changed every time
          a filter moved, and Daily showed three dots while this showed two. A
          key that changes with the data is not a key. `only` is now ignored by
          the component; the call is left as documentation of what it used to
          do. */}
      <CategoryLegend note="The bar and the rule down the left edge are fit. A grey dot after a company name means the board has not touched that posting in a week." />
    </>
  );
}
