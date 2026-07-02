import { z } from "zod";
import { defineCaraAction } from "../actionNative/defineCaraAction";
import { runCaraAction } from "../actionNative/runCaraAction";
import type { CaraActionContext } from "../actionNative/caraActionTypes";
import { sendOnboardingLink, type OnboardingLinkType } from "../onboardingConversation";

export const onboardingLinkTypeSchema = z.enum([
  "client_payment",
  "client_identity",
  "caregiver_membership",
  "caregiver_photo",
  "caregiver_documents",
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
    return { success: result.success, linkType: result.linkType, sent: true };
  },
});

export async function runSendOnboardingLinkAction(
  input: unknown,
  ctx: CaraActionContext,
): Promise<{ success: boolean; linkType: OnboardingLinkType; sent: boolean }> {
  return runCaraAction(sendOnboardingLinkCaraAction, input, ctx);
}
