import type { Intent } from "./intentClassifier";
import { maybeRecordShadowRun } from "./routingShadow";
import { runQaAgent } from "./qaAgent";

/**
 * U7/U8/U9 tap connector. Wires the MCP tool loop (in shadow mode + skipSend, so
 * U11 guarantees zero side effects and nothing is sent) as the shadow counterpart
 * to a live cascade flow, recording the loop's outcome to routing_shadow for the
 * convergence pilot. Kept in its own module (imports runQaAgent) so routingShadow.ts
 * stays dependency-light and unit-testable.
 *
 * DARK by default: maybeRecordShadowRun no-ops (and never spawns the shadow loop)
 * unless the flow is enabled in ROUTING_CONVERGENCE_SHADOW.
 */

// Intent → shadow flow key. Only intents whose live flow is a convergence
// candidate map here; everything else returns null (never shadowed). Safety/
// protocol/onboarding intents are intentionally absent (spike "do not migrate").
const INTENT_TO_FLOW: Partial<Record<Intent, string>> = {
  TRIGGER_MANAGEMENT: "reminder_management",   // U7 pilot
  MODIFY_SCHEDULE:    "modify_schedule",       // U8 reversible cluster
  UPDATE_AVAILABILITY:"availability",
  UPDATE_RATE:        "caregiver_profile",
  UPDATE_SKILLS:      "caregiver_profile",
  UPDATE_BIO:         "caregiver_profile",
  SWAP_REQUEST:       "swap",
  CLIENT_SWAP_REQUEST:"client_swap",
  FIND_REPLACEMENT:   "replacement",
  APPROVE_TIMESHEET:  "timesheet_approval",    // U9 financial cluster
  REQUEST_REFUND:     "refund",
  CANCEL_SHIFT:       "cancel_shift",
};

export function intentToShadowFlow(intent: Intent | null | undefined): string | null {
  return (intent && INTENT_TO_FLOW[intent]) ?? null;
}

export async function shadowTap(params: {
  flow: string;
  intent: Intent;
  text: string;
  phone: string;
  chatId: string;
  userId?: string;
  seniorId?: string;
  userType: "client" | "caregiver";
  session: Record<string, unknown>;
}): Promise<void> {
  await maybeRecordShadowRun({
    flow: params.flow,
    phone: params.phone,
    intent: params.intent,
    runShadow: async () => {
      const toolNames: string[] = [];
      const iterationsOut: number[] = [];
      const t0 = Date.now();
      const reply = await runQaAgent({
        text:        params.text,
        phone:       params.phone,
        chatId:      params.chatId,
        userId:      params.userId ?? "",
        seniorId:    params.seniorId ?? params.userId ?? "",
        userType:    params.userType,
        session:     params.session as any,
        intent:      params.intent,
        skipSend:    true,   // never user-facing
        shadowMode:  true,   // U11 — never executes a mutating tool
        _toolCallsOut: toolNames,
        _iterationsOut: iterationsOut,
      });
      return { outcome: { reply, tools: toolNames.slice().sort() }, latencyMs: Date.now() - t0, reply, toolNames, iterations: iterationsOut[0] ?? 0 };
    },
  });
}
