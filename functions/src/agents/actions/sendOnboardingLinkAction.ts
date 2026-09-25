import { z } from "zod";
import { defineCaraAction } from "../actionNative/defineCaraAction";
import { runCaraAction } from "../actionNative/runCaraAction";
import type { CaraActionContext } from "../actionNative/caraActionTypes";
import { sendOnboardingLink, type OnboardingLinkType } from "../onboardingConversation";
import { checkGateLinkThrottle, stampGateLinkResentIfParked } from "../gateLinkCooldown";

export const onboardingLinkTypeSchema = z.enum([
  "client_payment",
  "client_identity",
  "caregiver_membership",
  "caregiver_photo",
  "caregiver_transport_docs",
  "caregiver_background_check",
  "caregiver_payouts",
]);

export const sendOnboardingLinkCaraAction = defineCaraAction({
  name: "send_onboarding_link",
  description: "Generate and send a tappable onboarding or setup link through Linq.",
  inputSchema: z.object({
    phone: z.string().min(1),
    linkType: onboardingLinkTypeSchema,
  }),
  outputSchema: z.object({
    success: z.boolean(),
    linkType: onboardingLinkTypeSchema,
    sent: z.boolean(),
    // Gate-cooldown throttle fields (set only on a suppressed resend — see
    // runSendOnboardingLinkAction below; a real send never carries them).
    throttled: z.boolean().optional(),
    minutesSinceLastSend: z.number().optional(),
    instruction: z.string().optional(),
  }),
  readOnly: false,
  modelVisible: true,
  webVisible: true,
  adminOnly: false,
  publicAllowed: false,
  allowedRoles: ["client", "caregiver", "admin", "system"],
  audit: {
    actionType: "onboarding_link_sent",
    targetCollection: "agent_sessions",
    targetDocId: input => (input as { phone?: string }).phone,
  },
  idempotencyKey: input => `send_onboarding_link:${input.phone}:${input.linkType}`,
  // Payment/identity links mint Stripe sessions — never execute when duplicate
  // protection is unverifiable.
  failClosed: true,
  run: async input => {
    const result = await sendOnboardingLink(input.phone, input.linkType as OnboardingLinkType);
    // A REAL send to a session parked at this linkType's gate-awaiting step
    // opens the SAME per-step cooldown window the scripted `other`-branch
    // resends use — so an agent tool send and an inbound-text resend can never
    // stack two link cards inside one window. Runs only inside `run` (never on
    // an idempotency-ledger replay, which sends nothing). Best-effort; a
    // failed stamp never fails the send. Non-parked sessions are untouched.
    if (result.success) await stampGateLinkResentIfParked(input.phone, input.linkType);
    return { success: result.success, linkType: result.linkType, sent: true };
  },
});

export interface SendOnboardingLinkResult {
  success: boolean;
  linkType: OnboardingLinkType;
  sent: boolean;
  throttled?: boolean;
  minutesSinceLastSend?: number;
  instruction?: string;
}

export async function runSendOnboardingLinkAction(
  input: unknown,
  ctx: CaraActionContext,
): Promise<SendOnboardingLinkResult> {
  // Gate-link resend cooldown (U9 follow-up, 2026-07-17): when the target
  // session is parked at this linkType's own gate-awaiting step and that
  // step's 10-minute window is open, do NOT send — return a truthful
  // structured result the agent can relay honestly (the link went out N
  // minutes ago; replying LINK resends it instantly — the deterministic
  // escape hatch the scripted path honors). Checked BEFORE runCaraAction so
  // a throttled non-send is never settled into the idempotency ledger as a
  // completed send. Invalid input and non-parked sessions fall through to
  // the unchanged action path (fail-open, same rule as the scripted resend).
  const parsed = sendOnboardingLinkCaraAction.inputSchema.safeParse(input);
  if (parsed.success) {
    const { phone, linkType } = parsed.data;
    const throttle = await checkGateLinkThrottle(phone, linkType);
    if (throttle.throttled) {
      const mins = throttle.minutesSinceLastSend ?? 1;
      const minsText = `${mins} minute${mins === 1 ? "" : "s"}`;
      return {
        success: true,
        linkType: linkType as OnboardingLinkType,
        sent: false,
        throttled: true,
        minutesSinceLastSend: mins,
        instruction:
          `NO link was sent this turn — do NOT claim you just sent one. That ${linkType} link already went out ` +
          `about ${minsText} ago. Tell the user it was sent about ${minsText} ago and to give it a moment to ` +
          `arrive; if it still hasn't come through, they can reply LINK and it will be resent instantly.`,
      };
    }
  }
  return runCaraAction(sendOnboardingLinkCaraAction, input, ctx);
}
