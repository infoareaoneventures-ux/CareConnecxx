import * as admin from "firebase-admin";
import { isRoutingShadowEnabled } from "../config/featureFlags";

const db = admin.firestore();

/**
 * U6: routing-convergence shadow-comparison harness (spike + KTD-5/KTD-10).
 *
 * When a flow is enabled in ROUTING_CONVERGENCE_SHADOW, the live (user-facing)
 * handler runs as normal AND, in parallel and NON-user-facing, the MCP tool loop
 * runs in shadow mode (U11 isolation guarantees zero side effects). Both outcomes
 * are captured to `routing_shadow` so a flip/hold decision (U7) is made on data,
 * never on intuition.
 *
 * DARK by default: when the flow's flag is off, maybeShadow is a no-op with no
 * overhead, so wiring the tap into a live route is safe before the pilot starts.
 */

export type EndState = Record<string, unknown>;

// KTD-10: per-flow canonical end-state projection. A flow registers the named
// fields that define "agreement" so the comparison isn't fooled by incidental
// non-determinism (free-text reasons, timestamps). Until a flow registers, we
// deep-compare whatever is passed.
const FLOW_PROJECTIONS: Record<string, (raw: EndState) => EndState> = {
  // reminder_management (U7 pilot): the reminder's action + text + time only —
  // reversible, no money/clinical data, the spike's recommended first flow.
  reminder_management: (raw) => ({
    action: raw.action ?? null, // "created" | "deleted" | "listed"
    text:   raw.text ?? null,
    time:   raw.time ?? null,
  }),
};

export function projectEndState(flow: string, raw: EndState): EndState {
  const project = FLOW_PROJECTIONS[flow];
  return project ? project(raw) : raw;
}

export function endStatesAgree(flow: string, live: EndState, shadow: EndState): boolean {
  return JSON.stringify(projectEndState(flow, live)) === JSON.stringify(projectEndState(flow, shadow));
}

export interface ShadowRun {
  outcome:    EndState;
  latencyMs:  number;
  reply:      string;
  toolNames:  string[];
  iterations: number;
}

export async function captureShadowComparison(rec: {
  flow: string; phone: string;
  live: { outcome: EndState; latencyMs: number };
  shadow: ShadowRun;
}): Promise<boolean> {
  const agree = endStatesAgree(rec.flow, rec.live.outcome, rec.shadow.outcome);
  await db.collection("routing_shadow").add({
    flow: rec.flow, phone: rec.phone, agree,
    live: rec.live, shadow: rec.shadow,
    capturedAt: new Date().toISOString(),
  }).catch((err) => console.warn("routingShadow: capture failed (non-fatal)", err));
  return agree;
}

/**
 * Run the shadow comparison for a flow IF it's enabled. The caller supplies the
 * live handler's projected outcome/latency and a `runShadow` closure (which wires
 * runQaAgent with shadowMode:true + skipSend:true). Always non-fatal — a shadow
 * failure must never affect the live turn.
 */
export async function maybeShadow(params: {
  flow: string;
  phone: string;
  liveOutcome: EndState;
  liveLatencyMs: number;
  runShadow: () => Promise<ShadowRun>;
}): Promise<void> {
  if (!isRoutingShadowEnabled(params.flow)) return; // dark — no-op, no overhead
  try {
    const shadow = await params.runShadow();
    await captureShadowComparison({
      flow: params.flow, phone: params.phone,
      live: { outcome: params.liveOutcome, latencyMs: params.liveLatencyMs },
      shadow,
    });
  } catch (err) {
    console.warn("routingShadow: shadow run failed (non-fatal)", { flow: params.flow, err });
  }
}
