"use client";
import { usePathname } from "next/navigation";
import { WINDOW_HORIZON_DAYS } from "@/lib/display";

const LINKS = [
  ["/", "Daily"],
  ["/companies", "Companies"],
  // People sits between Companies and Inbox because that is the order the work
  // happens in: Companies says who to know, People is the knowing, and Inbox is
  // the roles. It is not last, and it is not behind the footer with the
  // maintenance views, because the pipeline's own conclusion is that this is
  // the highest-leverage surface in the tool.
  ["/people", "People"],
  // Outreach sits directly after People and before Inbox, continuing the same
  // order: Companies says who to know, People is the knowing, Outreach is the
  // queue of companies where nobody is known yet, and Inbox is the roles.
  ["/outreach", "Outreach"],
  ["/apply", "Apply"],
  // Applied sits immediately after Apply, because it is the other half of the
  // same act: /apply is the pack the owner takes to the form, /applications is the
  // record that he sent it. Every other page in this nav shows what the tool
  // PREPARED; this is the only one that shows what he DID, which is the gap
  // the audit found -- zero applications, zero contacts touched, 121 packs
  // unused, and nothing in the system able to see it.
  ["/applications", "Applied"],
  ["/inbox", "Inbox"],
  ["/forecast", "Forecast"],
  ["/resumes", "Resumes"],
];

/**
 * The badge used to sit on Daily reading "4", which was the number of open
 * application windows — not four of anything on Daily, and not four things to do.
 * A number next to a page name is read as "this page has 4 items for you".
 *
 * It now sits on Forecast, counts only windows closing inside the horizon, and
 * does not appear at all when that count is zero. Daily's freshness stamp
 * already carries the one urgent state that page has.
 *
 * The tooltip reads the SAME constant the count is computed from. It used to
 * say "inside 21 days" as a string literal, so when the horizon moved to 45 the
 * badge counted one thing and described another — caught only by reading the
 * deployed HTML.
 */
export default function Nav({ closingSoon = 0 }) {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map(([href, label]) => (
        <a key={href} href={href} className={path === href ? "on" : ""}>
          {label}
          {href === "/forecast" && closingSoon > 0 && (
            <span className="cnt urgent" title={`application windows closing inside ${WINDOW_HORIZON_DAYS} days`}>
              {" "}
              {closingSoon}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}
