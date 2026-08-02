// ── CHILD → SENIOR vertical switch, from inside the childcare path ───────────
//
// Front door Stage 2, deliverable 6a. Stage 1 shipped the pure switch module
// (agents/verticalFrontDoor.ts) supporting BOTH directions and wired only
// senior → child (agents/onboardingConversation.ts::handleVerticalSwitchTurn,
// which runs on senior onboarding turns). The child → senior direction had no
// conversational owner at all: a childcare-stamped session that said "wait, this
// is actually for my mother" was answered with childcare copy forever.
//
// WHY IT LIVES HERE AND NOT IN childcare/signupIngress.ts
// The ingress has a binding contract: STATIC templates, no LLM, no interpolated
// user text (R33/R57 — it is the module that must never be able to leak a child
// detail into a message). Switch detection is inherently a model judgement, so
// putting it there would break that contract. This module is the LLM turn's
// legitimate home; the ingress calls it and stays template-only itself.
//
// COST: zero unless the text actually carries a senior signal. The deterministic
// pre-pass gates the model call, so the overwhelming majority of childcare turns
// spend nothing here — the same discipline handleVerticalSwitchTurn uses.
//
// R-FD7 IS PRESERVED EXACTLY: detection NEVER re-stamps. It parks a hold, asks
// for confirmation, honours the TTL and the max-re-ask deny-by-default, and only
// an explicit affirmative moves the authoritative vertical.

import * as admin from "firebase-admin";
import {
  detectDeterministicSignals,
  detectVerticalSwitch,
  type CareRole,
} from "./verticalClassifier";
import {
  buildVerticalSwitchConfirmation,
  buildVerticalSwitchHold,
  clearVerticalSwitchHold,
  readVerticalSwitchHold,
  resolveVerticalSwitchConfirmation,
  VERTICAL_SWITCH_MAX_ASKS,
} from "./verticalFrontDoor";
import { classifyExplicitYesNo } from "./childcareCaregiverFunnel";
import { CHILDCARE_CAREGIVER_FUNNEL_FIELD } from "./childcareCaregiverFunnel";

type Db = admin.firestore.Firestore;
type SendMessageFn = (chatId: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;

/** In-memory marker so one inbound is never classified twice across call sites. */
const CHECKED_MARKER = "_childcareVerticalSwitchChecked";

export interface ChildcareSwitchTurnParams {
  phone: string;
  chatId: string;
  text: string;
  session: Record<string, unknown>;
  db?: Db;
  sendMessage: SendMessageFn;
  executionContext?: unknown;
  now?: Date;
  /** Test seam — same signature as verticalClassifier.detectVerticalSwitch. */
  detect?: typeof detectVerticalSwitch;
}

export interface ChildcareSwitchTurnResult {
  /** True when this turn was CONSUMED by the switch machinery. */
  handled: boolean;
  /** Machine-stable outcome, safe to log. */
  outcome: string;
}

const NOT_HANDLED = (outcome: string): ChildcareSwitchTurnResult => ({ handled: false, outcome });

/**
 * Consult the child → senior switch on one childcare-session inbound.
 *
 * Returns `handled: false` for the overwhelming majority of turns, and the
 * caller then continues with its normal childcare routing unchanged.
 */
export async function handleChildcareToSeniorSwitchTurn(
  params: ChildcareSwitchTurnParams,
): Promise<ChildcareSwitchTurnResult> {
  const session = params.session;
  const text = String(params.text ?? "");
  if (!text.trim() || text === "__RESUME__") return NOT_HANDLED("no_text");
  if (session[CHECKED_MARKER]) return NOT_HANDLED("already_checked");
  session[CHECKED_MARKER] = true;

  const db = params.db ?? admin.firestore();
  const now = params.now ?? new Date();
  const sendOpts = params.executionContext ? { executionContext: params.executionContext } : undefined;
  const sessionRef = db.collection("agent_sessions").doc(params.phone);
  const currentRole: CareRole | null =
    session.userType === "caregiver" ? "caregiver" : session.userType === "client" ? "client" : null;

  const patch = async (fields: Record<string, unknown>): Promise<void> => {
    Object.assign(session, fields);
    await sessionRef.set(fields, { merge: true }).catch((err) => {
      console.error("[childcareVerticalSwitch] session write failed:", err instanceof Error ? err.message : err);
    });
  };

  // ── (1) A parked switch is awaiting confirmation: THIS turn is the answer ───
  const hold = readVerticalSwitchHold(session.pendingVerticalSwitch, now);
  if (session.pendingVerticalSwitch && !hold) {
    // Expired — abandon it and let the turn continue as an ordinary childcare turn.
    await patch(clearVerticalSwitchHold());
    return NOT_HANDLED("hold_expired");
  }
  if (hold?.switchTo === "senior") {
    const answer = classifyExplicitYesNo(text);
    if (answer === "unclear") {
      if (hold.asks >= VERTICAL_SWITCH_MAX_ASKS) {
        // Deny by default: an unconfirmed switch NEVER re-stamps (R-FD7).
        await patch(clearVerticalSwitchHold());
        return NOT_HANDLED("switch_abandoned");
      }
      await patch(buildVerticalSwitchHold("senior", now, hold.asks + 1));
      await params.sendMessage(params.chatId, buildVerticalSwitchConfirmation("senior"), sendOpts);
      return { handled: true, outcome: "switch_reask" };
    }
    const result = resolveVerticalSwitchConfirmation({
      switchTo: "senior",
      affirmative: answer === "yes",
      // Irrelevant for the senior direction, but the argument is required and a
      // switch AWAY from childcare must not depend on childcare being enabled.
      childcareEnabled: true,
    });
    if (!result.confirmed) {
      await patch(result.sessionPatch);
      await params.sendMessage(
        params.chatId,
        "Got it — staying with childcare then. Where were we?",
        sendOpts,
      );
      return { handled: true, outcome: "switch_declined" };
    }
    // Confirmed. Re-stamp senior, clear CHILDCARE routing state (there is no
    // childcare collected state to clear — R-FD4 forbids the childcare
    // conversation from holding recipient detail at all — but the funnel's own
    // step/data is vertical-specific and must not ride along), then re-enter the
    // untouched senior funnel at ask_role so every existing handler sees the
    // exact shape it always saw.
    await patch({
      ...result.sessionPatch,
      [CHILDCARE_CAREGIVER_FUNNEL_FIELD]: null,
      onboardingStep: "ask_role",
    });
    await params.sendMessage(
      params.chatId,
      "Got it — let's set this up for an adult instead. Are you looking for care for a loved one, " +
      "or are you a caregiver looking for work?",
      sendOpts,
    );
    return { handled: true, outcome: "switch_confirmed_senior" };
  }

  // ── (2) Detect a NEW switch. Model call ONLY when a senior signal is present ─
  if (!detectDeterministicSignals(text).senior) return NOT_HANDLED("no_senior_signal");

  const detect = params.detect ?? detectVerticalSwitch;
  const detection = await detect({
    text,
    currentVertical: "child",
    currentRole,
  }).catch(() => ({ switchTo: null as null, reason: "parse_error" as const }));
  if (detection.switchTo !== "senior") return NOT_HANDLED(`no_switch_${detection.reason}`);

  await patch(buildVerticalSwitchHold("senior", now));
  await params.sendMessage(params.chatId, buildVerticalSwitchConfirmation("senior"), sendOpts);
  return { handled: true, outcome: "switch_hold_parked" };
}
