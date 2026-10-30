/**
 * WHICH DIGEST TRIGGERS EXIST, in priority order. The one definition.
 *
 * WHY IT IS ITS OWN MODULE AND NOT PART OF notify.js. genconfig.mjs needs this
 * list at BUILD time, to decide which switches to read out of config.yaml. It
 * used to import it from notify.js, which was fine until lib/transfer.js began
 * reading the baked allowance out of config.generated.js — because notify.js
 * imports transfer.js, and that closed a loop:
 *
 *     genconfig -> notify.js -> transfer.js -> config.generated.js
 *                     ^                              |
 *                     +-- which genconfig WRITES ----+
 *
 * It ran fine on this laptop, where config.generated.js already existed from
 * the last build, and would have failed on a fresh clone and on the Actions
 * runner with ERR_MODULE_NOT_FOUND. That is precisely the shape
 * test_ci_scripts.py exists to catch: a gitignored build artefact that every
 * local check happens to have and no clean machine does.
 *
 * So the list lives here, in a module with NO imports of its own. A build-time
 * script can read it without dragging the runtime in behind it.
 *
 * NOT RETYPED ANYWHERE. notify.js re-exports these, genconfig imports them, and
 * test_notify.mjs asserts config.yaml and this list agree — a second copy went
 * stale once already, and the baked config silently lacked the new key while
 * `on()` defaulted it to true, so config.yaml could not switch it off.
 */
export const TRIGGERS = [
  // ABOVE EVERYTHING, INCLUDING A FAILED RUN.
  //
  // A window opening at Google APM is the single most time-sensitive thing this
  // tool can say: last cycle's ran 30 Sep to 28 Oct, a 28-day window, and
  // McKinsey's closed on 11 August while companies.yaml said mid/late
  // September. A cycle missed is a cycle gone -- there is no recovering it in
  // March. A failed pipeline is recoverable by re-running the pipeline.
  //
  // "Irreversibility beats urgency" is already the rule that orders Daily; this
  // is that rule applied to the digest.
  "window_opened",
  // The five people to write to today. Under a window opening -- a
  // window closes whether or not he acts, a person waits.
  "todays_five",
  // The daily run errored, so every other number in the digest is suspect.
  // Exempt from the once-a-day cap: a pipeline that fails twice is worth
  // hearing about twice.
  "pipeline_failure",
  // SECOND, directly under a failed run, and for the same reason. A board that
  // stopped answering means that company's roles are stale or gone while every
  // other number on the page still looks calm — the run was green, the
  // freshness stamp is today's. It outranks a closing window because it says
  // the data underneath the window may be wrong, and a decision made on wrong
  // data is worse than a decision made late.
  "board_anomaly",
  // A watched page moved. Below a board going silent, because a board
  // that stopped answering means today's data is wrong, while a page
  // that changed is news to read rather than a number to distrust.
  "pages_changed",
  "closing_window",
  // The three consulting windows, which are rolling and therefore never trip
  // the closing_window steps. Below windows with real dates, above overdue
  // tasks: it is a standing reminder, not news, and it repeats until submitted.
  "consulting_open",
  // An apply flow that cannot be completed. Below the windows, because a
  // window closing is a date running out and this is a door that is shut
  // either way -- but above `overdue`, because an overdue task is one the owner
  // can still do and this is one he CANNOT, however much he means to. It is
  // the only thing in the digest that no amount of effort on his part clears.
  //
  // It repeats, like consulting_open, and is defensible for the same reason:
  // it has an answer. `python apply_blocks.py unblock <key>` stops it for
  // good, so it is a standing fact rather than a nag.
  "manual_apply",
  "overdue",
  "new_excellent",
  "weekly_retro",
];

export const TRIGGER_RANK = Object.fromEntries(TRIGGERS.map((k, i) => [k, i]));
