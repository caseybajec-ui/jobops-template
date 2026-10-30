"use server";

import { revalidatePath } from "next/cache";
import { addNote } from "@/lib/db";

// setStageAction lived here and is GONE. It backed the per-posting stage select
// in the expanded row, which LifecycleControl replaced: that select wrote one
// value keyed by a JOB key, so it forgot which role it was about whenever a
// requisition churned, and it kept no history. Nothing called this any more,
// and an unused Server Action is an ungated-by-default write endpoint sitting
// there for no reason.

export async function addNoteAction(key, text) {
  const t = (text || "").trim();
  if (!t) return;
  await addNote(key, t);
  revalidatePath("/");
}
