"use client";

import { useState } from "react";
import { today as todayLocal, daysFromToday } from "@/lib/day";
import { useRouter } from "next/navigation";
import { postItem, useAction } from "./useAction";
import {
  horizon, itemAge, stalled, stallReason, STALL_DAYS, openItems,
} from "@/lib/display";
import { chipClass, urgencyOf } from "@/lib/chips";
import { parentProgress, ageSignal } from "@/lib/scheduler";
import { Meter } from "./Palette";

/**
 * How far an item can be pushed, and what each push is called.
 *
 * "Not this week" was the only option, and it is the wrong answer to most
 * things: an item that needs a day to cool off was shoved a full week, and an
 * item that genuinely is not this week looked identical to one due tomorrow.
 * Every one of these still counts as a deferral, and three deferrals stalls the
 * item — offering shorter pushes must not become a way to make that invisible.
 */
const SNOOZE = [[1, "Tomorrow"], [3, "In 3 days"], [7, "Next week"]];

/**
 * What "when" means. A number of days, or a word.
 *
 * The field was `type="number"` with the placeholder "days", which is a
 * question most people answer with a word. Typing "today" into it did nothing
 * at all — the browser refuses the keystroke — so the only way to say "today"
 * was to work out that it is 0.
 *
 * Returns a NUMBER, null for "no date", or `false` for something unparseable.
 * false rather than null so an unreadable answer is refused out loud instead of
 * silently becoming an item with no due date, which is a different item.
 */
export function parseWhen(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  const WORDS = {
    today: 0, now: 0, tomorrow: 1,
    "this week": 3, "next week": 7, "in a week": 7,
    fortnight: 14, "two weeks": 14, "next month": 30,
  };
  if (s in WORDS) return WORDS[s];
  const n = Number(s.replace(/\s*days?$/, ""));
  if (Number.isFinite(n) && n >= 0 && n <= 3650) return n;
  return false;
}

/**
 * What the boxes SAY, versus what they show as an example.
 *
 * These are different jobs and were doing each other's. A placeholder has to
 * survive a 390px screen without truncating — "Email the business school career
 * office about MBB dates" clipped to "Email the business sch" on a phone, which reads
 * as a broken field rather than as a hint — so the placeholders are short and
 * say what the box is FOR. The long, specific examples moved to the line below,
 * where there is a full width to render them in.
 */
const PLACEHOLDERS = [
  "Add something the tool can't see",
  "why it matters (optional)",
  "when? today, 3, next week",
];

/**
 * One real example per load, rotated.
 *
 * Rotated rather than listed because three at once is a wall to skim past and
 * one is a sentence you read. Chosen by the DAY rather than at random so the
 * server render and the browser's first paint agree — a random pick here is a
 * hydration mismatch, which React reports as an error in the console and
 * repairs by throwing away the server's HTML.
 */
const EXAMPLES = [
  "Ask a family contact at Lockheed who runs their LDP",
  "Rewrite the top resume bullet with the cost number in it",
  "Pull 5 alumni names at Anduril",
  "Email career services about BCG's date",
  "Book a 15-minute slot with the career center",
];
export function exampleForDay(d = new Date()) {
  const day = Math.floor(Date.parse(d.toISOString().slice(0, 10) + "T00:00:00Z") / 86400000);
  return EXAMPLES[((day % EXAMPLES.length) + EXAMPLES.length) % EXAMPLES.length];
}


/**
 * Items that are really a WHOLE PROJECT get a link to the surface that holds
 * them, and their real progress instead of a checkbox.
 *
 * Matched on the TITLE rather than on the seed id, because a seed id is a hash
 * of the line in daily.yaml — editing a word in that line changes the id, and a
 * link keyed to it would silently stop working with nothing on screen to say so.
 */
const PROJECTS = [
  [/SF-?86/i, "/sf86", "the evidence pack"],
];

/** One on-you item: tick it off, or click the due label to change it. */
function Item({ item, ord, progress = {}, isUnit = false, siblings = [] }) {
  const router = useRouter();
  const done = useAction(item.done);
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(item.dueIn ?? 7);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const h = horizon(item.dueIn);
  // A child with no date of its own. The parent holds the schedule; this row
  // has no deadline to report and never had one.
  const undatedChild = isUnit && item.dueIn === null;

  async function tick(next) {
    if (next) setLeaving(true);            // 300ms fade, then it is gone
    await done.toggle(item.id, "done", next);
    setLeaving(false);
    router.refresh();
  }

  async function saveDue() {
    setErr(null);
    const n = Number(days);
    const at = Number.isFinite(n)
      ? daysFromToday(n)
      : null;
    try {
      await postItem({ id: item.id, dueAt: at });
      setEditing(false);
      router.refresh();
    } catch (e) {
      setErr(e.message);
    }
  }

  const why = (item.note || "").trim();
  const cut = why.search(/\.\s/);
  const lead = cut > 30 ? why.slice(0, cut + 1) : why;
  const rest = lead.length < why.length ? why.slice(lead.length).trim() : "";

  const overdue = item.dueIn !== null && item.dueIn < 0;
  const age = itemAge(item);
  const aging = ageSignal(item.ageDays);
  const project = PROJECTS.find(([re]) => re.test(item.title || ""));
  const pct = project ? progress[project[1]] : null;

  /**
   * Push it out. The answer for a thing that is real but not now.
   *
   * Three lengths rather than one, because "not this week" was the only option
   * and it is the wrong answer to most of them: an item that needs a day to
   * cool off got shoved a full week, and an item that genuinely is not this
   * week looked identical to one that is due tomorrow.
   *
   * All three count as a DEFERRAL, and three deferrals stalls the item
   * permanently — the same rule as before. Pushing something away repeatedly is
   * a decision, and offering shorter pushes must not become a way to make that
   * decision invisible.
   */
  async function snooze(days) {
    setBusy(true);
    setErr(null);
    const at = daysFromToday(days);
    try {
      await postItem({ id: item.id, dueAt: at, defer: true });
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * "Stuck" — records the state, and splits the item when somebody has written
   * the smaller steps down by hand. Nothing generates them; an item with no
   * steps simply says so, which is still better than the row pretending nothing
   * is wrong.
   */
  async function markStuck() {
    setBusy(true);
    setErr(null);
    try {
      await postItem({ id: item.id, action: "stuck" });
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`item${leaving ? " leaving" : ""}`}>
      <span className="ord">
        <input
          type="checkbox"
          checked={done.on}
          disabled={done.busy}
          aria-label={`Mark "${item.title}" done`}
          onChange={(e) => tick(e.target.checked)}
        />
        <span className="ordnum">{ord}</span>
      </span>

      <span className="what">
        {item.title}
        {/* "1 of 16", so a single row reads as part of a run rather than as the
            only thing left. Without it, finishing today's item looks like
            finishing the whole project. */}
        {isUnit && siblings.length > 1 && (
          <span className="unitmark">
            {" "}{siblings.filter((c) => c.done).length + 1} of {siblings.length}
          </span>
        )}
      </span>

      {editing ? (
        <span className="when">
          <input
            type="number"
            min="0"
            max="3650"
            value={days}
            style={{ width: 62 }}
            onChange={(e) => setDays(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveDue()}
          />
          <button type="button" onClick={saveDue}>set</button>
        </span>
      ) : (
        <button
          type="button"
          /* Three levels, from the same rule the deadline rows use. It was
             binary — orange inside 7 days, grey outside — so an item due in 12
             days and one due in 300 looked identical, and the two states the
             page actually has are "this week" and "not this week". Amber is
             quieter than the old orange, so the ones inside a week now stand
             out MORE than they did while a second level was added below them. */
          /* FILLED for a real closing, OUTLINED for a date he set himself.
             They rendered identically before, though missing one costs an
             afternoon and missing the other costs a recruiting cycle.

             The classes now come from chipClass(), the same function the chip
             component uses. This button WAS a second chip implementation with
             its own `.chip-filled` / `.chip-outline` rules and its own idea of
             the scale — it had three steps where the component has four, so a
             thing due today rendered exactly like one due in six days. Two
             implementations of one visual language is how the language stops
             meaning anything. */
          className={`when linkish ${undatedChild ? "nodate" : chipClass("urgency", (urgencyOf(item.dueIn, item.deadline_kind) || {}).tone, item.deadline_kind !== "external")}`}
          title={undatedChild
            ? "This one is today's, from the parent above. Click to give it a date of its own."
            : "Change when this is due"}
          onClick={() => setEditing(true)}
        >
          {/* A CHILD HAS NO DATE BY DESIGN — the parent holds the schedule and
              surfaces one child a day. Rendering "NO DATE" on it was the tool
              reporting the absence of something it never intended to have, on
              every surfaced task, in the same slot where a real deadline
              appears. It is not "today" either: the scheduler chose it for
              today, which is a fact about the queue rather than a date anybody
              set, and writing "today" in the deadline slot would be inventing
              one. So: nothing at rest, and the affordance to set a real date
              appears on hover. */}
          {undatedChild ? <span className="nodatehint">set a date</span> : h.label}
        </button>
      )}

      <span className="why">
        {lead}
        {rest && (
          <details>
            <summary>more</summary>
            <p>{rest}</p>
          </details>
        )}

        {/* COUNT UP. The due label counts down; this says how long the thing has
            actually been sitting there, which for an item nobody has opened in
            twelve days is the number that describes reality. */}
        {/* AGE AS A SIGNAL, not a date. "added 5 days ago" was under every
            task — noise on one added yesterday, far too quiet on one ignored
            for a fortnight. Nothing under three days; gold to nine; red past
            that. It counts UP, because a countdown implies progress. */}
        {/* Built as a value, not interpolated into the className string: a
            bare "u-" survives test_classes.mjs stripping the interpolation and
            gets reported as a class nobody wrote. Same trap as sf-${field}. */}
        {aging && (
          <span className={`itemage ${aging.level === "now" ? "u-now" : "u-soon"}`}>
            {aging.text}
          </span>
        )}

        {/* A checkbox is the wrong shape for weeks of intermittent work: it
            cannot honestly be ticked until the whole thing is done, and it
            says nothing about how far along it is. So this item shows how far
            along it IS, and links to where the work happens. */}
        {project && (
          <span className="itemproject">
            <a href={project[1]}>Open {project[2]}</a>
            {typeof pct === "number" && (
              <span className="dim"> — {pct}% assembled</span>
            )}
          </span>
        )}

        {/* THE ASK. Only when it is overdue, and only three answers, because
            anything you cannot answer in one click is a nag — and a nag you
            cannot answer teaches you to close the tab. */}
        {overdue && !item.stuck && (
          <span className="ask">
            <span className="dim">Still on this?</span>
            <button type="button" disabled={done.busy || busy} onClick={() => tick(true)}>
              Done
            </button>
            {SNOOZE.map(([days, label]) => (
              <button key={days} type="button" disabled={busy}
                      title={`Push it to ${new Date(Date.now() + days * 86400000)
                        .toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
                      onClick={() => snooze(days)}>
                {label}
              </button>
            ))}
            <button type="button" disabled={busy} onClick={markStuck}>
              Stuck
            </button>
          </span>
        )}
        {item.stuck && !item.split && (
          <span className="itemage">
            marked stuck{item.steps?.length ? "" : " — no steps written for it"}
          </span>
        )}
        {stalled(item) && (
          <span className="itemage">{stallReason(item)}</span>
        )}
        {(done.error || err) && <span className="acterr"> {done.error || err}</span>}
      </span>
    </li>
  );
}

/**
 * A project, as one row.
 *
 * "Confirm the 16 dates nobody is watching" and "Pull 15 alumni names" are not
 * tasks, they are lists, and rendering their children inline would put sixteen
 * identical rows on the page — which is the wall this whole phase exists to
 * remove. One row, a progress bar, and an expander for anyone who wants to see
 * the shape of what is left.
 *
 * The parent has NO checkbox. It is finished when its children are, and a tick
 * box that lies about what it means is worse than none — the same reason the
 * SF-86 item became a link to a percentage rather than something to check off.
 */
function Parent({ item, kids = [], today, next = null }) {
  const [open, setOpen] = useState(false);
  const p = parentProgress(item, kids);
  const surfaced = kids.find((c) => c.surfaced_on === today && !c.done);
  const upNext = !surfaced && p.done < p.total ? next : null;

  /**
   * ONE LINE WHEN THERE IS NOTHING TO DO ABOUT IT.
   *
   * This row used to cost four: the title, a counter, a progress bar, and the
   * sentence "Nothing surfaced today." — four lines to report an absence, on
   * both parents, every day. The bar is the same fact as the counter beside it
   * and the sentence is the same fact as the missing child below it, so the
   * page said the same nothing three times.
   *
   * Now: title · count · next up, and the bar moves inside the expander where
   * somebody asking "how much is left" can still see its shape. "next up:
   * Anduril" is the pick the SCHEDULER would make, passed down from the plan —
   * not a guess the view makes, because find_names orders by company ranking
   * and confirm_date by staleness and re-deriving either here is two
   * implementations of one rule.
   *
   * When a child IS surfaced it renders directly beneath this row as the
   * numbered item — see the list below — so the parent does not need to
   * announce it either.
   */
  return (
    <li className="item parentrow">
      {/* No number. A parent is a running total, not a job. */}
      <span className="ord" />

      <span className="what">
        {item.title}
        {upNext && upNext.company && (
          <>
            <span className="sep"> · </span>
            <span className="dim">next up: {upNext.company}</span>
          </>
        )}
        {p.done === p.total && p.total > 0 && (
          <>
            <span className="sep"> · </span>
            <span className="dim">all done</span>
          </>
        )}
        {/* ON the line, not under it. The expander lived in `.why`, which
            auto-places onto an implicit second grid row — so a row with nothing
            to report was still two lines tall, and the whole point of collapsing
            it was to get one. */}
        <span className="sep"> · </span>
        <button type="button" className="linkish parenttoggle"
                aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "hide" : `show all ${p.total}`}
        </button>
      </span>

      {/* The unit, named. "0 of 8" under "Pull 15 alumni names" reads as a
          miscount, because the title counts names and this counts companies. */}
      <span className="when dim">
        {p.done} of {p.total}{p.noun ? ` ${p.noun}` : ""}
      </span>

      {/* Nothing at all when closed — not an empty cell, which still claims a
          grid row. */}
      {open && (
      <span className="why">
        <Meter
          done={p.done}
          total={p.total}
          label={`${p.done} of ${p.total}${p.noun ? ` ${p.noun}` : ""} done.`}
        />
        <ol className="childlist">
            {kids.map((c) => (
              <li key={c.id} className={c.done ? "childdone" : ""}>
                {c.title}
                <span className="childstate">
                  {c.done
                    ? " — done"
                    : c.surfaced_on === today
                      ? " — today's"
                      : " — waiting, comes up after today's is done"}
                </span>
              </li>
            ))}
        </ol>
      </span>
      )}
    </li>
  );
}

export default function Items({ items, promotedId = null, progress = {}, nextUp = {} }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  // Three weeks past due with no answer is not work any more, it is furniture,
  // and leaving it in the list teaches you to read past the list. It is moved,
  // never deleted, and the group says exactly what it is.
  //
  // THE LADDER WINS, and it wins by taking the item away from this list rather
  // than by out-ranking it. Today's card and on-you item 04 both read "apply to
  // Accenture, Deloitte and EY-Parthenon", 600px apart, in slightly different
  // words — one task rendered as two, which makes the page look like it has more
  // to say than it does.
  //
  // So a promoted item is shown ONCE, at the top, and the list says it is up
  // there rather than silently dropping the count by one.
  const promoted = items.find((i) => i.id === promotedId && !i.done) || null;

  // PARENTS AND CHILDREN.
  //
  // A child is only in the open list when the scheduler surfaced it TODAY.
  // Every other child lives inside its parent's expander, so "Confirm the 16
  // dates nobody is watching" is one row rather than sixteen — which is the
  // whole point: sixteen identical rows is a wall, and a wall gets scrolled past.
  // The owner's date. See lib/day.js — this was UTC and page.js writes Pacific.
  const today = todayLocal();
  const parentIds = new Set(items.map((i) => i.parent_id).filter(Boolean));
  const isParent = (i) => parentIds.has(i.id);
  const isChild = (i) => !!i.parent_id;
  const surfacedToday = (i) => i.surfaced_on === today;

  const rest = items.filter((i) => !i.done && i.id !== promotedId);
  // ONE DEFINITION of what is on the open list, in lib/display.js, shared with
  // the section header that counts it. The two were near-copies and the header's
  // was missing `stalled`, so it claimed one more thing than the list showed.
  //
  // Parents are added back: openItems() drops them because a parent is a running
  // total rather than a job — which is the right answer for a COUNT and the
  // wrong one for a LIST, where the parent row is what holds the expander.
  const open = [
    ...openItems(rest, today),
    ...rest.filter((i) => isParent(i) && !stalled(i)),
  ].sort((a, b) => items.indexOf(a) - items.indexOf(b));
  const stale = rest.filter((i) => stalled(i) && !isChild(i));
  const done = items.filter((i) => i.done && !isChild(i));

  // Every child, surfaced or not, for the parent expanders.
  const childrenOf = (id) => items.filter((i) => i.parent_id === id);
  // A parent carries no unit_kind of its own; its children do, and every child
  // of one parent has the same one. Read from whichever is present rather than
  // stored on the parent, for the reason nothing here is stored twice.
  const kindOf = (id) => childrenOf(id).find((c) => c.unit_kind)?.unit_kind || null;

  async function add() {
    if (!title.trim()) return;
    const when = parseWhen(days);
    if (when === false) {
      setErr('When? A number of days, or "today", "tomorrow", "next week".');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await postItem({ title, note: note || null, dueInDays: when });
      setTitle(""); setNote(""); setDays("");
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {open.length ? (
        <ol className="items">
          {/* ONLY THE LEAVES ARE NUMBERED.
              The header said "4 things on you" over rows numbered 01 to 06,
              because the count is of actionable leaves and the numbering ran
              over every row including the two parents. A parent is a running
              total, not a thing to do — it has no checkbox and cannot be
              completed — so numbering it makes the list claim two more jobs
              than it holds. The counter beside a parent is its own progress;
              that is its number. */}
          {/* A SURFACED CHILD RENDERS UNDER ITS OWN PARENT.
              Both were in this list, in whatever order the list happened to
              produce, so "Confirm the 16 dates" could sit at 02 and the window
              it had actually chosen at 05, with two unrelated tasks between
              them. The parent then had to say "Today's is X, below" to point at
              its own child — a sentence that exists only because the layout
              separated two halves of one thing. Put them together and the
              sentence is unnecessary. */}
          {(() => {
            let leaf = 0;
            const inOpen = new Set(open.filter(isParent).map((i) => i.id));
            const rows = [];
            const leafRow = (it) => (
              <Item key={it.id} item={it} ord={String(++leaf).padStart(2, "0")}
                    progress={progress} isUnit={isChild(it)}
                    siblings={it.parent_id ? childrenOf(it.parent_id) : []} />
            );
            // PLAIN TASKS FIRST, THEN THE PROJECT GROUPS.
            //
            // Interleaved, the list read: parent, 01, 02, parent, 03 — a
            // running total, then a numbered task, then an unrelated numbered
            // task, then another running total. Every parent was a wall between
            // two consecutive numbers, and the numbering looked like it was
            // skipping rows it was not skipping.
            //
            // A parent is a different KIND of row: it has no checkbox and
            // cannot be completed. Sorting by kind puts every countable thing
            // in one uninterrupted run and every project below it, each still
            // directly above its own surfaced child.
            const leaves = open.filter((it) => !isParent(it)
              && !(isChild(it) && inOpen.has(it.parent_id)));
            const parents = open.filter(isParent);
            for (const it of leaves) rows.push(leafRow(it));
            for (const it of parents) {
              rows.push(
                <Parent key={it.id} item={it} kids={childrenOf(it.id)}
                        today={today} next={nextUp[kindOf(it.id)] || null} />,
              );
              const kid = open.find((c) => isChild(c) && c.parent_id === it.id);
              if (kid) rows.push(leafRow(kid));
            }
            return rows;
          })()}
        </ol>
      ) : promoted ? null : (
        <p className="nothing">
          Nothing on you today. Add anything the tool can&apos;t see.
        </p>
      )}

      {promoted && (
        <p className="promoted">
          &ldquo;{promoted.title}&rdquo; is the one at the top of this page.
        </p>
      )}

      <div className="additem">
        <input
          aria-label="What needs doing"
          /* A real example, not "Add an item…". An empty box with an abstract
             prompt gets abstract items, and an abstract item is one nobody can
             tell whether they have finished. */
          placeholder={PLACEHOLDERS[0]}
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <input
          aria-label="Why it matters"
          placeholder={PLACEHOLDERS[1]}
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        {/* TEXT, not number. It was type="number" with the placeholder "days",
            which is a question most people answer with a word — and the browser
            refuses the keystroke, so typing "today" did literally nothing. */}
        <input
          type="text"
          inputMode="text"
          aria-label="When it is due"
          placeholder={PLACEHOLDERS[2]}
          style={{ width: 168 }}
          value={days}
          disabled={busy}
          onChange={(e) => setDays(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button type="button" onClick={add} disabled={busy || !title.trim()}>Add</button>
        {err && <span className="acterr">{err}</span>}
      </div>
      <p className="additemhint">
        Anything the tool cannot see. For example: {exampleForDay()}
      </p>

      {stale.length > 0 && (
        <details className="more">
          <summary>{stale.length} stalled</summary>
          <p className="sub">
            More than {STALL_DAYS} days past due, or deferred three times. They are
            not going to happen as written: rewrite one, or answer it below and it
            comes straight back.
          </p>
          <ol className="items">
            {stale.map((it, i) => (
              // isUnit here too. A child rendered in the stalled list without it
              // falls back to "NO DATE" — the one place the chip survived after
              // the main list stopped showing it, which is exactly how a fix
              // ends up applied on three surfaces out of four.
              <Item key={it.id} item={it} ord={String(i + 1).padStart(2, "0")}
                    progress={progress} isUnit={isChild(it)} />
            ))}
          </ol>
        </details>
      )}

      {done.length > 0 && (
        <details className="more">
          <summary>{done.length} done</summary>
          <ol className="items">
            {done.map((it) => (
              <li className="item donerow" key={it.id}>
                <span className="ord">
                  <input
                    type="checkbox"
                    checked
                    aria-label={`Reopen "${it.title}"`}
                    onChange={async () => {
                      await fetch("/api/actions", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ key: it.id, kind: "done", on: false }),
                      });
                      router.refresh();
                    }}
                  />
                </span>
                <span className="what dim">{it.title}</span>
                <span className="when faint">
                  {it.doneAt ? it.doneAt.slice(0, 10) : ""}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}
