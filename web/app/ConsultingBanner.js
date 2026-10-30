"use client";

/**
 * The rolling windows (companies.yaml `rolling: true`) — open, nothing submitted.
 *
 * WHY A BANNER AND NOT A ROW. These cannot fire the ordinary
 * closing-window warning, because that one counts down from a date and their
 * date is a historical-estimate on windows whose own note says roles close as
 * they fill. So the surface that would normally carry them is structurally
 * blind to them, and they are the nearest live application path in the tool.
 *
 * IT SAYS "ROLLING", NOT A COUNTDOWN. Rendering "closes in 25 days" against an
 * estimated 30 September would be the McKinsey failure repeated: a date nobody
 * at the firm set, shown with the same authority as one they did. The honest
 * statement is that submission order is the filter.
 *
 * IT HAS AN ANSWER. It is the only banner here that repeats every day, and that
 * is only defensible because marking a firm applied removes it for good. A
 * recurring prompt with no way to discharge it is a nag, and a nag you cannot
 * answer teaches you to stop reading the page.
 */
export default function ConsultingBanner({ consulting }) {
  if (!consulting || !consulting.red) return null;
  const { outstanding, submitted, missing } = consulting;
  const done = submitted.length;
  const total = done + outstanding.length;

  return (
    <div className="warn">
      {outstanding.length > 0 && (
        <p>
          <strong>{outstanding.map((w) => w.firm).join(", ")}</strong> —{" "}
          open now, nothing submitted.{" "}
          {total > 1 && done > 0 && <>({done} of {total} done.) </>}
          These are <strong>rolling</strong>: roles close as they fill, so the
          submission date is the filter, not the published cutoff. Mark one
          applied on <a href="/forecast">Forecast</a> and it stops appearing.
        </p>
      )}
      {missing.length > 0 && (
        // NEVER SWALLOWED. A firm flagged rolling in companies.yaml that no
        // longer matches an open window there means the banner has quietly
        // stopped watching it — which looks identical to having nothing to do.
        <p>
          <strong>{missing.join(", ")}</strong>{" "}
          {missing.length === 1 ? "is" : "are"} flagged{" "}
          <code>rolling: true</code> in <code>companies.yaml</code> but no open
          window matched there. Either the firm was renamed or the window
          was marked closed. This is missing data, not a clear result.
        </p>
      )}
    </div>
  );
}
