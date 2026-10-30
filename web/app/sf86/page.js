import { getSf86, seedSf86, getSf86Affirmations } from "@/lib/contacts";
import Sf86 from "../Sf86";

export const dynamic = "force-dynamic";

export default async function Page() {
  // Seed the two known trips once, on first open. Guarded on the travel section
  // being completely empty rather than on a flag — a flag is a second source of
  // truth, and its failure mode is two duplicate trips on a pack somebody has
  // already curated.
  await seedSf86();
  const [{ rows, ready }, affirmations] = await Promise.all([getSf86(), getSf86Affirmations()]);
  return <Sf86 rows={rows} ready={ready} affirmations={affirmations} />;
}
