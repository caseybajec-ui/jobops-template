import { listJobs, listCompanies, listItems, groupRoles } from "@/lib/db";
import { getContacts } from "@/lib/contacts";
import { plural } from "@/lib/plural";

/**
 * GET /api/search — everything the palette can jump to.
 *
 * Fetched ONCE when the palette first opens and cached for its lifetime, rather
 * than per keystroke: a round trip between typing "sa" and "sar" is the
 * difference between a palette and a search box.
 *
 * Capped, deliberately. The corpus is 9,919 rows and nobody types their way to
 * the 400th role — the palette is for the things you half-remember the name of,
 * and Inbox with its filters is for everything else. Sending the lot would make
 * the first open slow on the one interaction that has to feel instant.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const items = [];

  try {
    const [jobs, companies, contacts, tasks] = await Promise.all([
      listJobs({ minScore: 40, limit: 300, cap: 0 }).catch(() => []),
      listCompanies({}).catch(() => []),
      getContacts().catch(() => []),
      listItems({ includeDone: false }).catch(() => []),
    ]);

    for (const c of companies) {
      items.push({
        kind: "company",
        label: c.display_name || c.name,
        sub: c.reachable40 ? `${plural(c.reachable40, "role")} fit you` : null,
        href: `/inbox?co=${encodeURIComponent(c.name)}&min=0&cap=0`,
      });
    }

    // Grouped, so a role posted in nine cities is one row here as it is
    // everywhere else. A palette listing the same title nine times is a palette
    // you scroll.
    for (const j of groupRoles(jobs)) {
      items.push({
        kind: "role",
        label: j.displayTitle || j.title,
        sub: j.display_name || j.company,
        href: j.url || `/inbox?co=${encodeURIComponent(j.company)}&min=0&cap=0`,
      });
    }

    for (const p of contacts) {
      items.push({
        kind: "person",
        label: p.name,
        sub: [p.role, p.display_name || p.company].filter(Boolean).join(" · "),
        href: `/people?co=${encodeURIComponent(p.company || "")}`,
      });
    }

    for (const t of tasks) {
      items.push({ kind: "task", label: t.title, sub: null, href: "/#onyou" });
    }
  } catch {
    // The palette already has the pages. Returning what was gathered beats
    // returning an error the palette cannot do anything with.
  }

  return Response.json({ items });
}
