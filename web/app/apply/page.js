import { listApplyPacks } from "@/lib/db";
import Apply from "../Apply";
import { resolved } from "@/lib/assert";

export const dynamic = "force-dynamic";

/**
 * The apply packs.
 *
 * force-dynamic because `used_at` changes the moment the owner copies a field, and
 * a page that showed a stale untouched count would be worse than no count.
 */
export default async function Page() {
  const packs = await listApplyPacks({});
  resolved(packs, "listApplyPacks");
  return <Apply packs={packs} />;
}
