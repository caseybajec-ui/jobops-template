import { Suspense } from "react";
import { headers } from "next/headers";
import Palette2 from "./Palette2";
import Tour from "./Tour";
import "./globals.css";
import Nav from "./Nav";
import { monthToDate } from "@/lib/cost";
import { getDeadlines, applyChecks } from "@/lib/deadlines";
import { windowChecks } from "@/lib/db";
import { WINDOW_HORIZON_DAYS } from "@/lib/display";

export const metadata = { title: "JobOps" };

async function CostMeter() {
  const { spent, cap, measured, since } = await monthToDate();
  const over = spent >= cap;
  // The bar keeps the text, it does not replace it. A number against a cap is
  // the fact the owner checks before deciding whether he can afford to score
  // anything, and it is exact; the bar only says how close the two are without
  // making him subtract. It stays grey until the cap is passed, because this is
  // an implementation detail he checks monthly and it already sat too loud once.
  const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
  return (
    <span className={`mono cost-meter${over ? " over" : ""}`}
          title={`Counted from ${String(since).slice(0, 10)} against the hard `
            + `$${cap.toFixed(2)}/month cap. `
            + (measured
               ? "Measured from actual token usage."
               : "A FLOOR — some batches have no measured usage yet and price low.")}>
      {measured ? "" : "~"}${spent.toFixed(2)}
      <span className={`costbar${over ? " over" : ""}`} aria-hidden="true">
        <span className="costfill" style={{ width: `${pct}%` }} />
      </span>
      ${cap.toFixed(2)} {over ? "OVER CAP" : "this month"}
    </span>
  );
}

export default async function RootLayout({ children }) {
  // The sign-in page gets the brand and nothing else.
  //
  // It used to get the whole chrome, which meant an unauthenticated visitor was
  // shown the nav AND the cost meter — "$1.70 / $5.00 this month" — before
  // typing anything. That is the owner's spend on the one page anybody can reach.
  // It also meant the layout queried the database for every hit on the gate.
  //
  // The path arrives as a header from the middleware; a root layout has no
  // other way to know which route it is wrapping.
  const bare = (await headers()).get("x-pathname") === "/login";

  // Only windows actually closing inside the horizon. The old count was every
  // open window, which is not a number that asks you to do anything today.
  //
  // The horizon is 45 days, not 21: at 21 this badge read 0 while the nearest
  // open window — the only application path currently available — closes in 33.
  // One constant, in lib/display.js, so the badge and the page cannot disagree.
  // Checks are folded in here too, or a window the owner dated by hand this
  // morning would be counted by the page and missed by the badge.
  const closingSoon = bare ? 0 : applyChecks(getDeadlines(), await windowChecks()).filter(
    (d) => d.status === "open" && d.closeIn !== null && d.closeIn <= WINDOW_HORIZON_DAYS
  ).length;
  return (
    <html lang="en">
      {/* Grammarly and similar extensions inject attributes on <body>,
          which React reports as a hydration mismatch. Not our markup. */}
      <body suppressHydrationWarning>
        <div className="topbar">
          <span className="brand">JobOps</span>
          {bare ? null : (
            <>
              <Nav closingSoon={closingSoon} />
            </>
          )}
        </div>
        {children}
        {/* Gate is a maintenance view — it answers "what did the rules delete
            and why", which matters when tuning them and never during a normal
            day. It was sitting in the main nav next to the four pages actually
            used to find a job. /about joins it here in step 4. */}
        {/* ⌘K anywhere, and the shortcut list behind "?". Rendered outside
            the bare/login branch so it never appears on the sign-in page. */}
        {bare ? null : <Palette2 />}
        {/* Reads ?tour= and renders nothing at all without it. Suspense because
            useSearchParams opts a component into client-side rendering, and Next
            requires the boundary rather than silently making the whole page
            dynamic. */}
        {bare ? null : (
          <Suspense fallback={null}>
            <Tour />
          </Suspense>
        )}
        {bare ? null : (
          <footer className="footer">
            <a href="/about">How this works</a>
            {/* A link, not a control. Starting a tour is a query parameter, so
                this and the ⌘K row are both ordinary anchors and the command
                palette's model — everything is a place you can go — is left
                alone. It also means a tour is shareable and bookmarkable. */}
            <a href="/?tour=interface">Take the tour</a>
            {/* The card is reached from the footer rather than the nav: it is
                a thing you open WHILE filling in a form somewhere else, not a
                place you go. Pulse sits beside it for the same reason — it is
                a weekly read, not a daily one. */}
            <a href="/profile">Profile card</a>
            <a href="/pulse">Pulse</a>
            {/* The whole database, as CSV, in a zip. A year of work behind one
                password on one Neon project is a single point of failure; a
                file on his own disk is the answer and costs one route. */}
            <a href="/api/export">Export everything</a>
            <a href="/sf86">SF-86 pack</a>
            <a href="/gate">What the rules filtered out</a>
            {/* The meter is an implementation detail the owner checks monthly, and it
                was sitting on the most prominent line of the chrome — the first
                thing a cold reader saw on a job-search page was an API bill. */}
            <span className="spacer" />
            <CostMeter />
          </footer>
        )}
      </body>
    </html>
  );
}
