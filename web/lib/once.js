/**
 * Run a read once per request, however many callers ask for it.
 *
 * WHY. One Daily render issued 47 queries, and they were not 47 different
 * questions — the same `actions` query ran 8 times, contacts and interactions 4
 * times each, role_flags twice. Nothing was wrong with any caller: Daily needs
 * saved keys, and so does the ladder, and so does the sort, and each politely
 * asked the data layer rather than threading a value through six components.
 *
 * On SQLite that was invisible. Against Neon every one of those is a network
 * round trip, and the same page already lost about a second to exactly this
 * shape once before — eight sequential awaits that had no dependency on each
 * other.
 *
 * REACT'S `cache` DOES THIS, and doing it by hand would be worse: a plain
 * module-level Map would leak between requests on a warm serverless instance,
 * which is how one user sees another's data. `cache` is scoped to a single
 * render pass and thrown away with it.
 *
 * OUTSIDE A RENDER IT IS A NO-OP, which is the property that makes it safe
 * here. The CLI scripts — the backfill, the notifier, the migration runner —
 * import the same data layer, and React memoizes nothing outside a request
 * context. So a long-running script never serves a stale row from a cache it
 * cannot see, and a write followed by a read behaves exactly as it reads.
 *
 * ONLY EVER WRAP A PURE READ. Anything that writes, or whose answer must change
 * within one render, must not come through here.
 */
import { cache } from "react";

export const once = cache;
