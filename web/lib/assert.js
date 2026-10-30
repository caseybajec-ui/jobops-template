/**
 * A missed `await` must throw, not render as nothing.
 *
 * This goes in BEFORE the async conversion, deliberately. It is only useful if
 * it is already there when the first missed await happens — added afterwards it
 * is a test for a bug you have already shipped.
 *
 * The failure it exists for: every function in db.js is about to become async.
 * Forget one `await` and the value is a Promise, which React renders as nothing.
 * A section quietly disappears — and "no roles today", "none owed", "nothing
 * closing inside 21 days" are all LEGITIMATE states on these pages, so an empty
 * section looks like an ordinary quiet Tuesday. There is no TypeScript here to
 * catch it at build time.
 *
 * So: assert at the point the data is handed to a component, name the function,
 * and throw. A page that errors is strictly better than a page that lies.
 */

const isThenable = (v) => v != null && typeof v.then === "function";

/**
 * Returns `value`, or throws if it is a Promise.
 * `name` should be the call you forgot to await, e.g. "listJobs".
 */
export function resolved(value, name) {
  if (isThenable(value)) {
    throw new Error(
      `${name}() returned a Promise that was never awaited.\n` +
      `  It is async now. React renders a Promise as nothing, so this would have\n` +
      `  shown as an empty section — which on this page looks like a normal quiet day.\n` +
      `  Fix: const x = await ${name}(...)`
    );
  }
  return value;
}

/** Assert a whole props bag at once: resolvedAll({ jobs, facets, counts }). */
export function resolvedAll(bag) {
  for (const [name, value] of Object.entries(bag)) resolved(value, name);
  return bag;
}
