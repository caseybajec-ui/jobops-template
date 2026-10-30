import { gateKills, gatePhrases, gateCounts } from "@/lib/db";
import Gate from "../Gate";
import { resolved } from "@/lib/assert";

export const dynamic = "force-dynamic"; // the CLI writes jobs.db behind us

export default async function Page({ searchParams }) {
  const sp = await searchParams;
  const filters = {
    gate: sp.gate || null,
    field: sp.field || null,
    q: sp.q || null,
  };
  const phrases = resolved(await gatePhrases(), "gatePhrases");
  const rows = resolved(await gateKills({ ...filters, limit: 400 }), "gateKills");
  const counts = resolved(await gateCounts(), "gateCounts");
  return (
    <Gate
      phrases={phrases}
      rows={rows}
      counts={counts}
      filters={filters}
    />
  );
}
