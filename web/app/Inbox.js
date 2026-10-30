"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import JobRow from "./JobRow";
import { bandOf } from "@/lib/display";
import Hint from "./Hint";

/**
 * The inbox — labelled controls, then rows.
 *
 * The controls used to be an unlabelled run of inputs and checkboxes. Each one
 * now says what it filters, and the toggles — the four that ADD normally-hidden
 * rows — sit on their own line, because they are a different kind of control
 * from the filters above them.
 */
export default function Inbox({
  jobs, facets, filters, actions = {}, appliedAt = {},
  newSince = null, hiddenCount = 0, referrals = [],
  lifecycle = {}, handledCount = 0, contactCounts = {}, hiddenCycle = [],
  where = null,
}) {
  // Which row is open lives in the URL hash, so a refresh — and every
  // router.refresh() after an action — does not collapse what you were reading.
  const [open, setOpen] = useState(null);
  useEffect(() => {
    const read = () => setOpen(decodeURIComponent(window.location.hash.slice(1)) || null);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const push = (patch) => {
    const p = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "" || v === null) p.delete(k);
      else p.set(k, v);
    }
    window.location.search = p.toString();
  };

  const toggle = (k) => {
    const next = open === k ? null : k;
    setOpen(next);
    window.history.replaceState(
      null, "",
      next ? `#${encodeURIComponent(next)}`
           : window.location.pathname + window.location.search
    );
  };
  const isNew = (r) =>
    newSince && r.first_seen && Date.parse(r.first_seen) > Date.parse(newSince);

  /**
   * How many of the folded filters are actually on, and which.
   *
   * Named individually rather than counted from a loop over `filters`, because
   * `filters` also carries Fit, Pay, Sort and the rest — the visible controls —
   * and a count that quietly included those would be a number describing a
   * different set from the panel it labels. Two numbers from one population is
   * the rule; this is one number from one population, stated once.
   *
   * `cap` is INVERTED: the cap is on by default, so the exceptional state is
   * cap === 0, and that is what counts as an active filter.
   */
  const TOGGLES = [
    [filters.showExperienced, "wants more experience"],
    [filters.showOtherYears, "other class years"],
    [filters.showClearance, "needs a clearance"],
    [filters.nearMe, "preferred locations only"],
    [filters.showHidden, "hidden"],
    [filters.showHandled, "handled"],
    [!(filters.cap > 0), "no per-company cap"],
  ].filter(([on]) => on).map(([, label]) => label);
  const activeToggles = TOGGLES.length;
  const toggleSummary = TOGGLES.join(", ");
  // Open if any is on, so a filtered list never looks unfiltered. Closing it is
  // still possible; what is not possible is a short list with no visible reason.
  const [showFilters, setShowFilters] = useState(activeToggles > 0);

  const Check = ({ on, param, label, title }) => (
    <label title={title}>
      <input
        type="checkbox"
        defaultChecked={on}
        onChange={(e) => push({ [param]: e.target.checked ? "1" : "" })}
      />
      {label}
    </label>
  );

  return (
    <>
      <div className="controls">
        <label>
          Fit
          <select
            defaultValue={String(filters.minScore || 0)}
            onChange={(e) => push({ min: e.target.value === "0" ? "" : e.target.value })}
          >
            <option value="0">All</option>
            <option value="70">Strong and up</option>
            <option value="55">Good and up</option>
          </select>
        </label>

        <label title="A programme is a named new-grad intake. Open to new grads is everything else that hires out of college.">
          Level
          <select
            defaultValue={filters.level || ""}
            onChange={(e) => push({ level: e.target.value })}
          >
            <option value="">Both</option>
            <option value="program">New-grad programs</option>
            <option value="entry">Open to new grads</option>
          </select>
        </label>

        <label title="A low band is a preference, not a disqualifier — unknown pay always survives this filter">
          Pay
          <select
            defaultValue={filters.payKnown ? "known" : String(filters.minPay || 0)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "known") push({ pay: "1", minpay: "" });
              else push({ pay: "", minpay: v === "0" ? "" : v });
            }}
          >
            <option value="0">Any</option>
            <option value="90000">$90K+</option>
            <option value="120000">$120K+</option>
            <option value="150000">$150K+</option>
            <option value="known">Published only</option>
          </select>
        </label>

        <label>
          Category
          <select
            defaultValue={filters.category || ""}
            onChange={(e) => push({ cat: e.target.value })}
          >
            <option value="">All</option>
            {facets.categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.n})
              </option>
            ))}
          </select>
        </label>

        <label>
          Company
          <select
            defaultValue={filters.company || ""}
            onChange={(e) => push({ co: e.target.value })}
          >
            <option value="">All</option>
            {facets.companies.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name} ({c.n}) · best {bandOf(c.best).toLowerCase()}
              </option>
            ))}
          </select>
        </label>

        <label>
          Sort
          <select
            defaultValue={filters.sort || "fit"}
            onChange={(e) => push({ sort: e.target.value })}
          >
            <option value="fit">Best fit</option>
            <option value="pay">Highest pay</option>
            <option value="new">Newest</option>
          </select>
        </label>
      </div>

      {/* SEVEN CHECKBOXES ON ONE LINE IS TWO LINES ON A LAPTOP.
          They wrapped at 1280 and pushed the first row of results below the
          fold, and six of the seven are off almost always — they answer "let me
          see something the inbox normally hides", which is a question you ask
          occasionally, not a control you steer with. Fit, Level, Pay, Category,
          Company and Sort stay visible because those are the ones that move.

          THE COUNT IS THE WHOLE POINT of folding them. A closed panel that does
          not say how many filters are on is how you end up staring at a short
          list wondering where the roles went — so the button carries the number
          and the button is emphasised whenever it is not zero. */}
      <div className="controls toggles">
        <button
          type="button"
          className={`filterbtn${activeToggles ? " on" : ""}`}
          aria-expanded={showFilters}
          onClick={() => setShowFilters(!showFilters)}
          title="Rows the inbox hides by default, and the per-company cap"
        >
          Filters{activeToggles ? ` · ${activeToggles}` : ""}
        </button>
        {activeToggles > 0 && !showFilters && (
          <span className="dim filtersum">{toggleSummary}</span>
        )}
      </div>

      {/* The  ATTRIBUTE, not a class. The UA stylesheet already hides
          it, the accessibility tree respects it, and a second mechanism spelled
          the same way is one more thing that can disagree with the first. */}
      <div className="controls toggles filterpanel" hidden={!showFilters}>
        <Check
          on={filters.showExperienced}
          param="exp"
          label="Show roles that want more experience"
          title="Roles wanting 2+ years tell you who hires this profile. They are not roles to apply to."
        />
        <Check
          on={filters.showOtherYears}
          param="yr"
          label="Show other class years"
          title="December 2026 graduates, and the class after yours"
        />
        <Check
          on={filters.showClearance}
          param="clr"
          label="Show roles requiring a clearance"
          title="An employer sponsors a clearance — you cannot obtain one in order to apply. Roles needing only eligibility are always shown."
        />
        {/* OFF by default, and it filters rather than reranks. Fit scores are
            untouched: Palantir Deployment Strategist is the top-fit role in the
            corpus and one of its locations is Colorado Springs, so weighting
            location into the ranking would push the best role on the board down
            the page to express a preference. */}
        <Check
          on={filters.nearMe}
          param="near"
          label="Preferred locations only"
          title="New York, the Bay Area, or remote. Off by default — this filters the list and never changes a fit score."
        />
        <Check
          on={filters.showHidden}
          param="hidden"
          label={`Show hidden${hiddenCount ? ` (${hiddenCount})` : ""}`}
          title="Roles you hid. They stay hidden everywhere until you unhide them."
        />
        <Check
          on={filters.showHandled}
          param="handled"
          label={`Show handled${handledCount ? ` (${handledCount})` : ""}`}
          title="Roles you have applied to, been rejected from, or been ghosted by. They leave the list because the inbox is decisions still to make."
        />
        {/* Inverted on purpose: this one is ON by default, so the URL carries
            the exception (cap=0) rather than the normal state. */}
        <label title="Palantir alone was 17 of the uncapped top 25 — without a cap the ranking measures board size, not fit">
          <input
            type="checkbox"
            defaultChecked={filters.cap > 0}
            onChange={(e) => push({ cap: e.target.checked ? "" : "0" })}
          />
          Max 3 per company
        </label>
      </div>

      {filters.curatedOnly && (
        <p className="sub">
          Showing only what Daily chooses from: roles for your class, under the
          new-grad pay ceiling, with no clearance requirement.{" "}
          <a href="/inbox?min=0">Show everything a new grad can get</a>.
        </p>
      )}

      <div className="sheet-rows">
        <div className="row head">
          <span style={{ textAlign: "right" }}>
            fit
            <Hint id="band">
              How well the role matches your profile, as a word rather than a
              number: the scorer only produces about nineteen distinct values and
              moves by ten points either way between runs, so a four-point gap
              means nothing. Click any row to see exactly why it landed where it did.
            </Hint>
          </span>
          <span>
            company
            <Hint id="category">
              The coloured dot is what kind of company it is — defense, product,
              consulting, or VC. The legend is at the foot of the page.
            </Hint>
          </span>
          <span>role</span>
          <span>location</span>
          <span>level</span>
          <span style={{ textAlign: "right" }}>pay</span>
          <span />
        </div>

        {jobs.length === 0 && (
          <div className="empty">
            Nothing matches these filters. Widen Fit or Pay, or switch a toggle on.
          </div>
        )}

        {jobs.map((j) => (
          <JobRow
            key={j.groupKey}
            job={j}
            actions={actions}
            appliedAt={appliedAt[j.groupKey]}
            isNew={isNew(j)}
            expanded={open === j.groupKey}
            onToggle={() => toggle(j.groupKey)}
            referrals={referrals}
            lifecycle={lifecycle[j.groupKey] || null}
            contactCounts={contactCounts}
          />
        ))}
      </div>

      {/* Where the CURRENT result set actually is. It answers the question the
          location column cannot: how much of this board is in the two cities he
          wants. Counts a role once per metro it touches, so the parts can sum
          to more than the whole — a role in both New York and San Francisco is
          genuinely two answers, and the sentence says so rather than pretending
          otherwise. */}
      {where && where.total > 0 && (
        <p className="wherethese">
          <strong>Where these {where.total} roles are:</strong>{" "}
          {where.named.map((m, i) => (
            <span key={m.key}>
              {i > 0 && <span className="sep"> · </span>}
              {m.label} {m.n}
            </span>
          ))}
          {where.other.length > 0 && (
            <>
              <span className="sep"> · </span>
              elsewhere {where.otherTotal}
              <span className="dim"> ({where.other.map((o) => `${o.label} ${o.n}`).join(", ")}
                {where.other.length < 4 ? "" : ", and more"})</span>
            </>
          )}
          <span className="dim">
            {" "}— {where.preferred} of {where.total} are in New York, the Bay Area,
            or remote. A role listed in several cities counts in each.
          </span>
        </p>
      )}

      <WrongCycleList rows={hiddenCycle} />

    </>
  );
}

/**
 * The undo list, at the foot of Inbox and collapsed.
 *
 * Hiding a role everywhere is the one action in this app with no visible
 * consequence — the row simply stops existing, on every page, and there is
 * nowhere to press Unhide because there is no row to press it on. Without a
 * list, a mis-click is unrecoverable and invisible, which is exactly the class
 * of thing this codebase keeps writing down: never destroy without a way back.
 *
 * Collapsed, because the whole point is that these are out of the way. The
 * count in the summary is the only part that has to be visible, and it is the
 * honest answer to "did that button do anything".
 */
function WrongCycleList({ rows = [] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  if (!rows.length) return null;

  async function unhide(r) {
    setBusy(r.key);
    setErr(null);
    try {
      const res = await fetch("/api/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The SCOPE it was hidden at, not always "role". A role caught by its
        // company's flag stays hidden however many times you un-hide the role,
        // and a button that does nothing is the failure this list exists to
        // prevent, reproduced inside the fix for it.
        body: JSON.stringify({ scope: r.scope, key: r.key, on: false }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "could not undo");
      router.refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="cyclelist">
      <summary>
        Hidden as wrong cycle ({rows.length})
      </summary>
      <ul>
        {rows.map((r) => (
          <li key={r.key}>
            <span className="co">{r.display_name}</span>
            <span className="title">{r.title}</span>
            {/* The reason he typed, verbatim. It is the only record of the
                judgement and it is why the row is worth keeping at all. */}
            {r.note && <span className="dim">{r.note}</span>}
            {r.scope === "company" && (
              <span className="dim">the whole company</span>
            )}
            <button
              type="button"
              className="linkish"
              disabled={busy === r.key}
              onClick={() => unhide(r)}
            >
              {r.scope === "company"
                ? `show ${r.display_name} again`
                : "show it again"}
            </button>
          </li>
        ))}
      </ul>
      {err && <span className="acterr" role="status">{err}</span>}
    </details>
  );
}
