// Interview-identity guard — catches Evia's own reply naming a DIFFERENT
// caregiver than the one a just-succeeded schedule_interview call actually
// targeted.
//
// 2026-09-06 live bug: Evia replied "Yes, I sent Basra the interview
// request..." while the tool call underneath it used Imran's caregiverId —
// confirmed via Firestore that the created video_interviews doc was for
// Imran. The model's free text and its structured tool input are generated
// independently and nothing cross-checked them, so the family was told a
// wrong action succeeded, and the wrong caregiver got a live interview
// request they were never actually a match for in this exchange.
//
// This runs BEFORE the reply is sent/saved (mirrors the broken-record guard
// right below it in qaAgent.ts): if the reply names someone other than the
// caregiver the tool actually scheduled, it self-corrects rather than ship a
// confidently wrong confirmation — cancel the wrongly-created interview,
// tell the wrongly-targeted caregiver it was a mistake, page ops, and
// replace the outgoing reply with an honest holding message instead of
// guessing at the "right" caregiver (that risk is exactly what created this
// bug in the first place — see qaAgent's own reasoning for why).

import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";

const db = admin.firestore();

export interface InterviewIdentityGuardInput {
  reply:         string;
  interviewId:   string;
  caregiverId:   string;
  caregiverName: string;
  phone:         string;
}

// Returns the reply to actually send — unchanged when consistent, or a
// corrective holding message when a mismatch is caught and self-corrected.
export async function guardInterviewIdentityConsistency(
  input: InterviewIdentityGuardInput,
): Promise<string> {
  const { reply, interviewId, caregiverId, caregiverName, phone } = input;
  if (!reply.trim()) return reply;

  const verdict = await quickComplete(
    "An assistant just scheduled a caregiver interview. The interview was actually created with a " +
      `caregiver named "${caregiverName}". Does the DRAFT REPLY below claim the interview was ` +
      "scheduled, sent, or requested with a DIFFERENT, specifically-named caregiver (not that person)? " +
      `Reply YES only if it names a different specific person. Reply NO if it correctly names "${caregiverName}", ` +
      "or names no one specific.",
    reply,
    { maxTokens: 3 },
  ).catch(() => "NO");
  if (verdict.trim().toUpperCase() !== "YES") return reply;

  console.error("interviewIdentityGuard: reply names a different caregiver than the one actually scheduled — self-correcting", {
    phone, interviewId, caregiverId, actualName: caregiverName, preview: reply.slice(0, 150),
  });

  // The interview was created in error — cancel it rather than leave a live,
  // wrongly-targeted request sitting in the caregiver's queue. "requested" is
  // not in interviewLinkTrigger.ts's AGREED set, so no link/reminder work has
  // run yet — a plain status flip is enough, nothing else to unwind.
  await db.collection("video_interviews").doc(interviewId).update({
    status:          "cancelled",
    cancelledReason: "identity_mismatch_auto_corrected",
    cancelledAt:     new Date().toISOString(),
    // The family's side created it in error — the tab reads this as the
    // family's cancel. cancelledViaAgent keeps onVideoInterviewWrite from
    // texting the caregiver a second time on top of the apology below.
    cancelledBy:       "client",
    cancelledViaAgent: true,
    reschedulePendingTime: admin.firestore.FieldValue.delete(),
    rescheduledBy:         admin.firestore.FieldValue.delete(),
  }).catch((err) => console.error("interviewIdentityGuard: cancel failed", err));

  // Tell the wrongly-targeted caregiver so they aren't left sitting on a
  // stray request with no explanation.
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get().catch(() => null);
  const cgPhone = cgSnap?.data()?.phone as string | undefined;
  if (cgPhone) {
    const { sendToPhone } = await import("../linq/client");
    await sendToPhone(
      cgPhone,
      "Sorry — that interview request was sent to you by mistake and has been cancelled. No action needed on your end.",
    ).catch(() => {});
  }

  await createCaraOpsAlert({
    type:     "interview_identity_mismatch",
    severity: "high",
    phone,
    source:   "qaAgent",
    message:  `Evia scheduled an interview with the wrong caregiver (actually ${caregiverName}) and self-corrected by cancelling it.`,
    context:  { interviewId, caregiverId },
  }).catch(() => {});

  // Deliberately does NOT guess which caregiver was actually meant and retry
  // — that guess is exactly the failure mode being guarded against. A human
  // follow-up (paged above) or the family's own next message resolves it.
  return "Hold on — I need to double-check something before I confirm that interview. Give me just a moment and I'll follow up with the right details.";
}
