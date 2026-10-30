import { NOTIFY_TO } from "@/lib/constants";
import { NOTIFY } from "@/lib/config.generated";
import { TRIGGERS, buildTest } from "@/lib/notify";

/**
 * What gets emailed, where the switches are, and one click to test delivery.
 *
 * THE BUTTON IS A LINK TO GITHUB, and that is deliberate rather than a
 * shortcut. The brief asked both that sending happen from Actions rather than
 * from a Vercel request handler, and that a button verify delivery without
 * waiting for the cron. Those pull against each other: a button on this page
 * that actually sends IS a request handler sending mail, and the safety of the
 * whole feature rests on the send path living somewhere a person deliberately
 * triggers.
 *
 * So there is no send path on the web side at all — test_notify.mjs walks every
 * file under app/ and asserts none of them can reach the mail provider — and
 * this links straight to the workflow's Run button. One click, no cron wait.
 *
 * The exact text of the test email is rendered below it, so the CONTENT is
 * verifiable without sending anything at all.
 */
// WHICH REPOSITORY. The original hardcoded its owner's GitHub URL, which is a
// personal fact a template cannot carry. Vercel exposes the linked repo as
// NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER / _SLUG when system variables are enabled;
// NEXT_PUBLIC_JOBOPS_REPO overrides for any other host. Neither set: no link,
// and the copy says where the button is instead of pointing at the wrong fork.
const REPO = process.env.NEXT_PUBLIC_JOBOPS_REPO
  || (process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER && process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG
      ? `https://github.com/${process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER}/${process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG}`
      : null);
const DISPATCH = REPO ? `${REPO}/actions/workflows/notify-test.yml` : null;

const LABELS = {
  pipeline_failure: "The daily run failed",
  closing_window: "A window closes within 7 days with nothing submitted (again at 3 days, and at 1)",
  overdue: "A task went overdue, or a follow-up came due",
  new_excellent: "A new Excellent-fit role appeared",
  weekly_retro: "Monday: last week in review",
};

export default function NotifySettings() {
  const test = buildTest();

  return (
    <section className="section" id="email">
      <h2>
        Email
        <span className="h2note"> — to you, and to nobody else</span>
      </h2>

      <p className="sub">
        At most one message a day, sent by the 07:10 run, and{" "}
        <strong>only when something below actually fired</strong>. A quiet day
        sends nothing — a digest that arrives regardless is one you filter to a
        folder, and then the one that mattered goes there too.
      </p>

      <p className="note">
        It goes to <strong>{NOTIFY_TO}</strong> and there is no way to address
        anyone else: the recipient is a constant in the code, not a setting, and
        the send function takes no address. It comes <em>from</em>{" "}
        <strong>{NOTIFY.from}</strong>, which is editable in{" "}
        <code>config.yaml</code> — the return label is configurable, the
        recipient is not. The standing rule holds — this tool
        never sends anything to another human. Every message to a real person is
        drafted here, approved by you, and sent by you.
      </p>

      <p className="ivhead">What sets it off, in the order it leads with</p>
      <ol className="items notifylist">
        {TRIGGERS.map((k, i) => (
          <li className="item" key={k}>
            <span className="ord"><span className="ordnum">{String(i + 1).padStart(2, "0")}</span></span>
            <span className="what">{LABELS[k]}</span>
            <span className={`when ${NOTIFY.triggers[k] ? "" : "dim"}`}>
              {NOTIFY.triggers[k] ? "on" : "off"}
            </span>
          </li>
        ))}
      </ol>

      <p className="note">
        All of it is switched in <code>config.yaml</code> under{" "}
        <code>notifications</code> — a master <code>enabled</code>, and one line
        per trigger. There is no settings page, and saying &ldquo;in
        settings&rdquo; when there is not one would be worse than saying nothing.
        Email is currently <strong>{NOTIFY.enabled ? "on" : "off"}</strong>.
      </p>

      <p className="ivhead">Send a test now</p>
      <p className="sub">
        Sending happens in GitHub Actions, never from this page — a page that can
        send email is one bug away from sending a great deal of it. This link
        opens the workflow; press <strong>Run workflow</strong> and it goes
        immediately, without waiting for tomorrow&apos;s cron.
      </p>
      <p>
        {DISPATCH ? (
          <a className="railbtn" href={DISPATCH} target="_blank" rel="noreferrer">
            Send a test email now →
          </a>
        ) : (
          <>
            Open <code>notify-test.yml</code> under your repository&apos;s Actions
            tab. (Set <code>NEXT_PUBLIC_JOBOPS_REPO</code> to your repository URL
            and this becomes a button.)
          </>
        )}
      </p>
      <p className="note">
        Until <code>RESEND_API_KEY</code> is a repository secret it prints the
        email into the run log instead of sending it, and records the attempt as
        a dry run — which is a real outcome and does not look like a send.
      </p>

      <p className="ivhead">Exactly what the test says</p>
      <pre className="mailpreview">{test.subject}
{"\n"}{test.text}</pre>
    </section>
  );
}
