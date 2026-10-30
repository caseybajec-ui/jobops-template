/* Server shell around the client form.
 *
 * The form needs useSearchParams() to honour ?next=, and Next refuses to
 * prerender a page that reads search params outside a Suspense boundary — the
 * build fails rather than shipping a page that hydrates wrong. The boundary is
 * the fix, not force-dynamic: this page is static apart from that one hook.
 */
import { Suspense } from "react";
import LoginForm from "./LoginForm";

export default function Page() {
  return (
    <Suspense fallback={<p className="page-intro">Loading…</p>}>
      <LoginForm />
    </Suspense>
  );
}
