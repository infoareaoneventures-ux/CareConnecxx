// Link-promise net — guarantees "I'll send you the link" is followed by a link.
//
// During onboarding, links are delivered ONLY as a side effect of the
// send_onboarding_link tool. When the model NARRATES a link instead ("I'm
// pulling up your secure photo link — I'll send it here") without calling the
// tool, nothing ever arrives and nothing notices: the narration reply itself
// clears turn_watch, and the qa_answer promise net is skipped in onboarding
// mode. That silent broken promise was the 2026-07-07 live-test bug.
//
// This net runs after the qaAgent onboarding turn when NO link tool fired:
// it detects link-promise narration in Evia's own reply (cheap prescreen +
// quick-tier YES/NO — the reply is agent output, not user input, so the
// parseWithClaude rule for user intent doesn't apply to the prescreen), maps
// the current onboarding step to the link the user was promised, and delivers
// it deterministically via sendOnboardingLink. If delivery fails, it records a
// tracked `link` commitment so the sweep retries and escalates instead of
// going quiet.

import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { recordCommitment } from "./commitmentTracker";
import type { OnboardingLinkType } from "./onboardingConversation";

const db = admin.firestore();

// Prescreen on Evia's OWN reply so the classifier only runs when the reply
// could plausibly promise a link. Broad on purpose (see the hallucination-guard
// lesson: narrow trigger regexes gate the real check out of existence).
const LINK_MENTION = /\blink\b|\btap\b|\bbutton\b|\burl\b|enlace|bot[oó]n/i;

// Which link each gate step owes the user. Collection steps are deliberately
// absent: the gate-handoff nets in webhooks.ts drive the scripted sender the
// moment required fields complete — sending a gate link early would jump the
// flow (and the bio/persistence nets already cover that failure).
const STEP_TO_LINK: Record<string, OnboardingLinkType> = {
  caregiver_send_photo:          "caregiver_photo",
  caregiver_awaiting_photo:      "caregiver_photo",
  caregiver_send_documents:      "caregiver_documents",
  caregiver_awaiting_documents:  "caregiver_documents",
  caregiver_send_membership:     "caregiver_membership",
  caregiver_awaiting_membership: "caregiver_membership",
  caregiver_send_bgcheck:        "caregiver_background_check",
  caregiver_awaiting_bgcheck:    "caregiver_background_check",
  caregiver_send_stripe_connect: "caregiver_payouts",
  caregiver_awaiting_stripe:     "caregiver_payouts",
  client_send_payment:           "client_payment",
  client_awaiting_payment:       "client_payment",
  client_awaiting_identity:      "client_identity",
};

export async function fulfillNarratedLinkPromise(input: {
  phone:    string;
  chatId:   string;
  reply:    string;
  userType: "client" | "caregiver";
}): Promise<void> {
  const { phone, chatId, reply } = input;
  if (!LINK_MENTION.test(reply)) return;

  // Quick-tier YES/NO: is this reply promising a tappable link will ARRIVE
  // (vs. referencing one already sent, or merely talking about links)?
  const verdict = await quickComplete(
    "You will read one SMS an assistant just sent to a user. Decide if it tells the user that a " +
      "link/button/form is being sent to them or will arrive in this chat — e.g. \"I'll send the link\", " +
      "\"pulling up your secure link now\", \"you'll get a link here shortly\". " +
      "Reply NO if it only references a link already sent earlier, asks about a link, or merely mentions links. " +
      "One word: YES or NO.",
    reply,
    { maxTokens: 3 }
  ).catch(() => "NO");
  if (verdict.trim().toUpperCase() !== "YES") return;

  const session = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
  const step = (session.onboardingStep as string) ?? "";
  const linkType = STEP_TO_LINK[step];
  if (!linkType) return;

  console.warn("linkPromiseNet: narrated link with no tool call — delivering deterministically", {
    phone, step, linkType, preview: reply.slice(0, 120),
  });

  try {
    // Dynamic import: onboardingConversation has a heavy import graph and
    // (indirectly) imports qaAgent — a static import here would be circular.
    const { sendOnboardingLink } = await import("./onboardingConversation");
    const result = await sendOnboardingLink(phone, linkType);
    if (result?.success) return;
  } catch (err) {
    console.error("linkPromiseNet: deterministic delivery failed", err);
  }

  // Delivery failed — make the narrated promise a tracked one so the sweep
  // retries in ~5 minutes and escalates to a human if it fails again.
  await recordCommitment({
    phone,
    chatId,
    kind:        "link",
    promiseText: reply.slice(0, 300),
    linkType,
    userType:    input.userType,
    source:      "linkPromiseNet:narrated_link",
    dueInMs:     5 * 60_000,
  });
}
