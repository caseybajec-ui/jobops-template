import { parsePaste, dedupeRows } from "./grok.js";

/**
 * How a paste becomes rows: deterministic first, model only if that found
 * nothing.
 *
 * IT TAKES THE EXTRACTOR AS AN ARGUMENT rather than importing it. That is the
 * whole reason this is its own module: "the model is called exactly once when
 * nothing parsed, and never when something did" is the property that matters
 * most about this feature, and a route that reaches for a real API client
 * cannot be asked whether it called it. Same injection point as
 * do_collect(con, client=None) in apply_packs.py, for the same reason.
 *
 * grok.js stays free of it. That file says at the top that it does no network
 * and no model, and it should keep being true rather than true-with-a-caveat.
 */
export async function resolvePaste({ text, today, extract }) {
  const parsed = parsePaste(text, { today });
  const rows = dedupeRows(parsed.rows);

  // THE CONDITION IS THE SAFETY PROPERTY. A paste that yielded even one row
  // never reaches the model, so the model can never overwrite or contradict a
  // deterministic result -- there is nothing for it to disagree with. This is
  // also why the check is `rows.length` and not `parsed.format`: a format was
  // identified for any paste that produced rows, but rows are what matter.
  if (rows.length) {
    return { rows, method: parsed.format, called: false, note: null };
  }
  if (typeof extract !== "function") {
    return { rows: [], method: null, called: false, note: null };
  }

  const got = await extract({ text }).catch((e) => ({
    ok: false, rows: [], reason: e?.message || String(e),
  }));

  if (got?.rows?.length) {
    return {
      // A DATE THE MODEL DID NOT FIND IS THE PASTE'S DATE, not a guess. The
      // prompt tells it to return null rather than invent one, and this is
      // where that null becomes the same default the digest format uses.
      rows: dedupeRows(got.rows.map(
        (r) => ({ ...r, applied_date: r.applied_date || today }))),
      method: "model",
      called: true,
      note: null,
    };
  }

  // NAMED IN THE BANNER. "Nothing parsed" and "nothing parsed and the model
  // could not read it either" are different findings, and the second means the
  // format has changed and lib/grok.js is what should be fixed.
  return {
    rows: [],
    method: null,
    called: true,
    note: got?.reason
      ? ` The model fallback did not run: ${got.reason}`
      : " The model fallback read it too and found no applications.",
  };
}
