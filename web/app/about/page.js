import { bandCounts, funnel } from "@/lib/db";
import NotifySettings from "../NotifySettings";
import { getDeadlines } from "@/lib/deadlines";
import { resolved } from "@/lib/assert";
import { OWNER, USER_CLASS_YEAR } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * Written for the owner in three months, not for the owner today.
 *
 * By then they will have forgotten why fit is a word instead of a number, why
 * consulting never shows up, why pay looks low, and why there is no kanban
 * board. Those four go first, because those four are what they will actually
 * wonder about. Everything else is reference.
 */
export default async function Page() {
  const bands = resolved(await bandCounts(), "bandCounts");
  const fn = resolved(await funnel(), "funnel");
  const deadlines = resolved(getDeadlines(), "getDeadlines");
  const verified = deadlines.filter((d) => d.confidence === "verified").length;

  return (
    <div className="sheet prose">
      <h1 className="abouth">How this works</h1>

      <section className="section">
        <h2>The four things you&apos;ll wonder about</h2>

        <h3>Why is fit a word and not a number?</h3>
        <p>
          Because the number was never that precise. One model scores every role
          0–100, and across {bands.total} roles it only ever produces about
          nineteen distinct values — {bands.Strong} of them land in Strong, and
          most of those are the identical score. Re-scoring the same role moves it
          by around ten points either way. A two-digit number invited you to read
          a four-point gap as a difference; it isn&apos;t one. So the band is the
          display, the bar&apos;s length is the magnitude, and the raw number is in
          the expanded row if you want it.
        </p>
        <p>
          Which means <strong>the order within a band is doing the real work</strong>:
          saved first, then new since your last visit, then new-grad programmes,
          then roles that publish pay, then higher pay, then title. Never the raw
          score, because the raw score can&apos;t tell those roles apart.
        </p>

        <h3>Why does consulting never appear?</h3>
        <p>
          Because it cannot. The fetcher reads public job-board APIs — Greenhouse,
          Lever, Ashby, Rippling. MBB, the boutiques, most VC and growth-equity
          firms, and every big-tech APM programme run Workday or a custom system
          with no public feed. They are structurally invisible and always will be;
          adding more companies will never fix it.
        </p>
        <p>
          That is what the <a href="/forecast">Forecast</a> page&apos;s deadline
          table is for. Those {deadlines.length} windows are tracked by hand, and{" "}
          {verified === 1 ? "only one has" : `${verified} have`} been read from a
          firm&apos;s own site — the rest are prompts to check, not facts. A note in
          this repo once said the MBB window closed &ldquo;mid/late
          September&rdquo;. McKinsey actually closed on 11 August. Acting on that
          note would have cost a full recruiting cycle, which is why every date
          now carries where it came from.
        </p>

        <h3>Why does the pay look low?</h3>
        <p>
          It is <strong>base salary only</strong>. Equity is not captured, and not
          because nobody tried: of 706 postings, 457 mention equity and exactly one
          attaches a number. Some employers publish no pay at all — Palantir and
          Saronic never do — so &ldquo;not published&rdquo; there is company policy,
          not a gap in the data. Unknown pay is never treated as low pay: it sorts
          to the end of a pay view rather than to the bottom.
        </p>

        <h3>Why is there no board or pipeline view?</h3>
        <p>
          Because you graduate in {OWNER.graduation}, and almost every role on screen today
          will be filled long before you can start. A kanban board of applications
          would be mostly empty and would imply the job is to move cards. The real
          job right now is knowing <em>which companies hire your profile</em> so the
          relationship exists before the {USER_CLASS_YEAR} posting goes up — which is what{" "}
          <a href="/companies">Companies</a> is for. Applications happen in the
          autumn. There is a stage dropdown on every expanded role for when they do.
        </p>
      </section>

      <section className="section">
        <h2>What each page is for</h2>
        <p>
          <strong>Daily</strong> — the five minutes. What you saved, what only you
          can do, what closes soon, who owes you a reply, and a short list worth
          looking at. Everything else is a click away.
        </p>
        <p>
          <strong>Companies</strong> — the one that matters most this year. Who
          hires your profile, what the best role you could actually get there is,
          when they first posted {USER_CLASS_YEAR} roles, and who you know. Star a company to
          make it a target and get a next step.
        </p>
        <p>
          <strong>People</strong> — the half that decides whether this tool is
          worth opening in December. Everything on Companies and Inbox is
          intelligence for getting here. Add a name, log what happened, and the
          tool works out what you owe whom; a referral is what your own gap data
          says gets past a CS-degree screen and a clearance requirement. Names go
          in by hand, from the alumni directory and warm intros — nothing here
          looks anybody up, and nothing here sends anything.
        </p>
        <p>
          <strong>Inbox</strong> — every role, with filters. Fail-open by design:
          it shows everything a new grad can get, and the toggles add back what is
          hidden rather than taking things away. Roles you have applied to or been
          rejected from drop out; &ldquo;Show handled&rdquo; brings them back.
        </p>
        <p>
          <strong>Forecast</strong> — application windows that close, and a guess
          at when each company posts its {USER_CLASS_YEAR} roles. The &ldquo;confirm
          dates&rdquo; button walks you through the undated ones one at a time.
        </p>
        <p>
          <strong>The SF-86 pack</strong> — linked from the on-you item, not in
          the nav. Ten years of addresses, employers with a supervisor who can
          still be reached, every trip, every foreign contact. It saves as you
          type and it is nothing but notes: nothing is submitted anywhere, and
          nothing in this tool says anything about whether a clearance would be
          granted. That is a government adjudicator&apos;s decision, not yours
          and not this tool&apos;s.
        </p>
      </section>

      <section className="section">
        <h2>What the colours mean</h2>
        <p>
          Colour carries exactly five kinds of information here and nothing else.
          If something is coloured and is not one of these, it is a bug.
        </p>
        <p>
          <strong>Fit</strong> — green Excellent, blue Strong, gold Good, grey
          below that. It is on the bar, on the word, and as a thin rule down the
          left edge of the row, so a list can be ranked without reading it.
        </p>
        <p>
          <strong>How long is left</strong> — red inside a week, gold inside a
          month, grey beyond. On the on-you items and on anything with a closing
          date.
        </p>
        <p>
          <strong>How much to trust a date</strong> — a green chip was read off
          the firm&apos;s own site, an amber one was not.
        </p>
        <p>
          <strong>What kind of company</strong> — the small dot beside a name.
          Four muted colours, with a legend at the foot of every list.
        </p>
        <p>
          <strong>How much of something is done</strong> — a two-part bar, green
          for done and amber for not yet. The amber half is the point of it.
        </p>
      </section>

      <section className="section">
        <h2>Where the roles come from, and when</h2>
        <p>
          Four public job-board APIs — Greenhouse, Lever, Ashby and Rippling —
          polled once a day at <strong>07:10 Pacific</strong> by a scheduled run
          that is not on your laptop, so it happens whether or not the machine is
          open. Everything on every page is as fresh as that run; the stamp at the
          top of Daily says when it last fired, and turns red if it did not.
        </p>
        <p>
          Nothing is scraped. Every board here publishes a public feed, and the
          three categories that do not — consulting, VC, and big-tech APM — are
          tracked by hand on Forecast instead, because a scraper pointed at them
          would produce confident-looking wrong dates, which is worse than none.
        </p>
        <p>
          <strong>What it costs to run:</strong> a hard cap of $5 a month, with
          the month-to-date figure in the footer of every page. Fetching, all the
          filtering rules, this website and the database are free. Scoring is the
          only thing that costs anything, at roughly a third of a cent per role,
          and only roles that survive the deterministic rules are ever sent to a
          model. Nothing on the People page, the tracker or the evidence pack
          calls a model at all.
        </p>
      </section>

      <section className="section">
        <h2>The daily loop</h2>
        <p>
          A scheduled run at 07:10 fetches every board, applies the deterministic
          rules, and scores anything new. It fails quietly on a network error, so
          the stamp at the top of Daily says when the data was actually last
          refreshed — if it reads more than a day old, the run did not fire and
          nothing on screen is current.
        </p>
        <p>
          Cost is the constraint: a hard cap of $5/month, shown top right. Fetching
          and every rule is free; scoring is the only thing that costs anything, at
          roughly a third of a cent per role. Only roles that survive the
          deterministic rules are ever sent to a model.
        </p>
        <p>
          The database goes to sleep after five minutes of nobody using it and wakes
          itself on the next page load, so <strong>the first request after a quiet
          spell can take a moment longer</strong>. Nothing is wrong and there is
          nothing to restart — it does this to stay inside the free tier.
        </p>
        <p>
          <strong>If the whole site returns an error</strong>, the likeliest cause is
          the database&apos;s monthly compute allowance running out, which stops it
          until the month turns over. The meter above tracks the AI spend only and will
          look fine either way.
        </p>
        <p>
          Where to look:{" "}
          <a href="https://console.neon.tech" target="_blank" rel="noreferrer">
            console.neon.tech
          </a>{" "}
          → the <em>jobops</em> project → the usage figure on the project page, which
          reads <span className="mono">n / 100 CU-hours</span>. Normal use is around
          20 a month, so <strong>anything past 50 by mid-month means something is
          wrong</strong> — almost certainly a job reconnecting in a loop rather than
          you using the site too much. There is deliberately no second meter in here:
          one number in one place, and it is Neon&apos;s.
        </p>
        <p className="faint">
          Right now: {fn.open} postings open, {bands.total} a new grad can get,{" "}
          {bands.strongPlus} strong or better.{" "}
          <a href="/gate">What the rules filtered out</a> shows every excluded role
          and the exact phrase that excluded it.
        </p>
      </section>

      <section className="section">
        <h2>Six things this tool has told you</h2>
        <ol className="findings">
          <li>
            <strong>Defense is where the fit is.</strong> Twelve of the thirteen
            roles scoring 60+ were defense, not product — the opposite of the
            stated preference.
          </li>
          <li>
            <strong>Fit and pay barely overlap.</strong> Zero of the top fifteen by
            fit appear in the top fifteen by pay, which is why one combined list
            replaced two.
          </li>
          <li>
            <strong>The blockers are a degree screen and a clearance</strong> — both
            routed around by a referral, not by another project.
          </li>
          <li>
            <strong>Consulting, VC and big-tech APM are invisible</strong> to any
            fetcher, and are three of the strongest categories for this profile.
          </li>
          <li>
            <strong>Deadlines are the expensive thing to get wrong.</strong> A
            plausible-sounding note about the MBB window was off by seven weeks.
          </li>
          <li>
            <strong>Most postings are not for you</strong>, and that is fine. About
            four in five reachable roles land in Weak. The list getting shorter
            while getting truer is the point.
          </li>
        </ol>
      </section>

      <NotifySettings />
    </div>
  );
}
