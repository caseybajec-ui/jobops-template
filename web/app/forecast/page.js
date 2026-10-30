import { forecast2027, windowChecks } from "@/lib/db";
import { windowsApplied } from "@/lib/applications";
import { getDeadlines, applyChecks, undatedWindows } from "@/lib/deadlines";
import Forecast from "../Forecast";
import { resolved } from "@/lib/assert";
import { listItems } from "@/lib/db";
import { today } from "@/lib/day";

export const dynamic = "force-dynamic";

export default async function Page() {
  // The deadlines block used to be a separate component rendered above this
  // page. It is one of the two tables on the page, so it lives in Forecast.
  const rows = resolved(await forecast2027(), "forecast2027");
  // Checks folded in here as they are on Daily, or a window the owner dated this
  // morning would still be sitting in the confirm list.
  const [checks, applied, items] = await Promise.all([
    windowChecks(), windowsApplied(), listItems({ includeDone: false }),
  ]);

  // TODAY'S WINDOW COMES FROM THE SCHEDULER, not from a second eligibility rule
  // computed here. This page used to filter by the 14-day cooldown and announce
  // "Nothing is due a check" while the rail said "Confirm one now" and Daily
  // surfaced a child — three surfaces, three answers to one question.
  //
  // The scheduler decides WHETHER; the cooldown only ever decided WHICH.
  const surfaced = items.find(
    (i) => i.unit_kind === "confirm_date" && i.surfaced_on === today() && !i.done);
  const surfacedCompany = surfaced?.unit_company || null;
  const deadlines = applyChecks(resolved(getDeadlines(), "getDeadlines"), checks);
  return (
    <Forecast rows={rows} deadlines={deadlines} undated={undatedWindows(deadlines)}
              trackedWindows={[...applied]} surfacedCompany={surfacedCompany} />
  );
}
