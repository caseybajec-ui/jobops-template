"use client";

import { useRouter } from "next/navigation";
import { useAction } from "./useAction";

/**
 * Tick off the on-you item the ladder is showing.
 *
 * Needed because the item is no longer rendered in the ON YOU list — it was
 * appearing twice, once as this card and once as a row 600px below. Taking it
 * out of the list also took away its checkbox, and an instruction you cannot
 * mark finished is worse than a duplicated one. The control belongs on the thing
 * you act on, which is this card.
 */
export default function TodayDone({ itemId }) {
  const router = useRouter();
  const done = useAction(false);

  return (
    <p className="todaydone">
      <button
        type="button"
        disabled={done.busy || done.on}
        onClick={async () => {
          await done.toggle(itemId, "done", true);
          router.refresh();
        }}
      >
        {done.on ? "Done" : "Mark it done"}
      </button>
      {done.error && <span className="acterr">{done.error}</span>}
    </p>
  );
}
