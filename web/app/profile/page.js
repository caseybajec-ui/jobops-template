import ProfileCard from "../ProfileCard";
import { getProfile } from "@/lib/contacts";

export const dynamic = "force-dynamic";

/**
 * The profile card, full page.
 *
 * It exists because every application form asks the same twenty-odd questions
 * and the owner answers them from memory each time. Retyping is where a GPA loses a
 * digit, and nothing catches that afterwards.
 */
export default async function Page() {
  const { profile, ready } = await getProfile();
  return (
    <div className="sheet">
      <p className="page-intro">
        The fields every application form asks for. Copy one, or copy the lot as
        plain text and paste it into a Workday box. It saves as you leave each
        field — there is no save button, because a save button on a page you
        open to copy one thing is a step you skip.
      </p>
      <ProfileCard profile={profile} ready={ready} />
    </div>
  );
}
