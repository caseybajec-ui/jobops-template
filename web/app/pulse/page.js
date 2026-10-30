import Pulse from "../Pulse";
import { pulseRows, getPeople } from "@/lib/contacts";
import { listActiveApplications } from "@/lib/applications";
import { computePulse } from "@/lib/pulse";
import { USER_TZ } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * Does any of this work?
 *
 * The tool has recorded outreach and applications for weeks and never once said
 * whether they convert. That is the question that decides what the owner does with
 * his December: if alumni messages get replies and cold ones do not, the answer
 * is more alumni messages.
 */
export default async function Page() {
  const [{ contacts, interactions, ready }, apps] = await Promise.all([
    pulseRows(),
    listActiveApplications().catch(() => []),
  ]);
  const pulse = computePulse({ interactions, contacts, applications: apps, tz: USER_TZ });
  return <Pulse pulse={pulse} ready={ready} />;
}
