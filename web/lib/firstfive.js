/**
 * "What do I do first?" — the five things that get the search running, in order,
 * with a live done/not-done read from the database.
 *
 * NOT A TOUR. The tour explains the interface; this is a checklist of real work,
 * and every step is either done or it is not — the tool knows which, so it must
 * never ask for something already finished. That is the whole point of it, and
 * it is the property the test asserts hardest: a completed step is not dimmed,
 * not struck through, not moved to the bottom. It is gone.
 *
 * PURE. Everything it needs arrives as plain values, derived by the caller from
 * rows it already has on the page — this adds no query. Pure so the ordering and
 * the done-rules can be tested without a browser or a database, which is where
 * "why is it still asking me to add people" gets answered.
 *
 * ORDER IS ARGUED. People first, because the pipeline's own gap data says a
 * referral is what routes around a CS-degree screen and a clearance requirement,
 * and it is the slowest to pay off — a message sent today is a conversation in
 * three weeks. Then the one application window that is actually open, because it
 * closes. Then the first message, the first date confirmed, and the SF-86
 * section that is pure homework. Slowest-to-pay-off first, irreversible second,
 * homework last.
 */

/** How many names count as "covered" at one company. Mirrors lib/people.js. */
export const NAMES_TARGET = 2;

/**
 * The five steps, with `done` computed.
 *
 * `state` is:
 *   startCompany   { slug, label }  head of the Companies "start here" ranking
 *   contactsAt     number           people known at that company
 *   openWindows    [{ id, firm }]   manual windows open right now
 *   appliedWindows Set|array        window ids with an application recorded
 *   outreachSent   number           interactions of type outreach_sent
 *   confirmToday   { surfaced, done }
 *   sf86Contact    { pct, ready }   the foreign-contacts section only
 */
export function firstFiveSteps(state = {}) {
  const {
    startCompany = null, contactsAt = 0,
    openWindows = [], appliedWindows = [],
    outreachSent = 0,
    confirmToday = { surfaced: false, done: false },
    sf86Contact = { pct: 0, ready: false },
  } = state;

  const applied = appliedWindows instanceof Set
    ? appliedWindows : new Set(appliedWindows || []);
  const co = startCompany?.label || "the top company";
  const openN = openWindows.length;
  const appliedN = openWindows.filter((w) => applied.has(w.id)).length;

  return [
    {
      id: "names",
      title: `Add ${NAMES_TARGET} people at ${co}`,
      why: "A referral is what your own gap data says gets past a CS-degree "
         + "screen and a clearance requirement. It is also the slowest thing "
         + "here to pay off, which is why it is first.",
      href: startCompany
        ? `/people?add=1&co=${encodeURIComponent(startCompany.slug)}`
        : "/people?add=1",
      cta: "Open People",
      done: contactsAt >= NAMES_TARGET,
      // Shown so a half-finished step reads as half-finished rather than as
      // untouched. A step at 1 of 2 that looks identical to one at 0 of 2 is a
      // checklist you stop trusting.
      note: contactsAt > 0 ? `${contactsAt} of ${NAMES_TARGET} so far` : null,
    },
    {
      id: "consulting",
      title: openN === 1
        ? "Submit the application that is open now"
        : `Submit the ${openN || "open"} applications in the window that is open now`,
      why: "The only application window open to you right now, and it closes. "
         + "Consulting never appears in the inbox — nobody fetches it, so it is "
         + "on you or it does not happen.",
      href: "/#today",
      cta: "Go to the card",
      // Vacuously true when there is no open window, and that is correct: there
      // is nothing to submit, so the step is done and drops off.
      done: openN === 0 || appliedN >= openN,
      note: openN > 0 && appliedN > 0 ? `${appliedN} of ${openN} submitted` : null,
    },
    {
      id: "outreach",
      title: "Send the first message",
      why: "Nothing here sends anything for you. The draft is written from what "
         + "is actually true about the relationship, you read it, and you send it.",
      href: "/people",
      cta: "Open People",
      done: outreachSent > 0,
      note: null,
    },
    {
      id: "confirm",
      title: "Confirm today's date",
      why: "16 tracked windows have no close date at all. One is offered a day, "
         + "it takes about ten minutes, and a missed window costs a whole cycle.",
      href: "/forecast#confirm",
      cta: "Open Forecast",
      // Nothing surfaced means nothing to do today — done, and out of the way.
      done: !confirmToday.surfaced || !!confirmToday.done,
      note: null,
    },
    {
      id: "sf86",
      title: "Finish the SF-86 foreign contacts section",
      why: "The section people leave until a deadline. It is also a real answer "
         + "to “how quickly could you start the clearance process”, which "
         + "a defense recruiter will ask.",
      href: "/sf86",
      cta: "Open the pack",
      done: (sf86Contact?.pct || 0) >= 100,
      note: sf86Contact?.pct > 0 ? `${sf86Contact.pct}% complete` : null,
    },
  ];
}

/**
 * What to actually render: only what is not done, plus whether it is all done.
 *
 * THE FILTER IS THE FEATURE. Everything else here is presentation; this line is
 * the reason the thing exists, and it is why `firstFiveSteps` computes `done`
 * rather than the component doing it — a component that filters is a component
 * that can be rendered without filtering.
 */
export function firstFive(state = {}) {
  const all = firstFiveSteps(state);
  const open = all.filter((s) => !s.done);
  return {
    steps: open,
    doneCount: all.length - open.length,
    total: all.length,
    allDone: open.length === 0,
  };
}
