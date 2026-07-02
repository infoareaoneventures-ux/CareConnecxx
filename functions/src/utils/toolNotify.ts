import { sendToPhone } from "../linq/client";

// Structured outcome for downstream sends triggered by an MCP tool. The point
// of this helper is to stop hiding send failures inside `.catch(() => {})` —
// tools surface the outcome in their response so the qaAgent system prompt
// can tell Cara *"action completed but the message didn't go through"* instead
// of *"I let them know."*

export type NotifyOutcome =
  | { sent: true }
  | { sent: false; reason: string; error?: string };

// Action notifications (cancellation notices, APPROVE prompts, relayed
// messages) are must-deliver: when the Linq line is temporarily blocked they
// stay queued for this long rather than the default 15 minutes.
const NOTIFY_QUEUE_TTL_MS = 6 * 60 * 60 * 1000;

export async function trySend(
  phone:   string,
  message: string,
  source:  string,
): Promise<NotifyOutcome> {
  if (!phone) {
    return { sent: false, reason: "missing_phone" };
  }
  try {
    const outcome = await sendToPhone(phone, message, {
      queueTtlMs: NOTIFY_QUEUE_TTL_MS,
      source,
    });
    // Previously a circuit-breaker drop returned void and was reported as
    // sent — Cara would tell the user "I let them know" about a message that
    // never went out. Surface the real outcome instead.
    if (outcome === "queued") {
      return { sent: false, reason: "queued_for_retry" };
    }
    if (outcome === "dropped") {
      return { sent: false, reason: "linq_line_unavailable" };
    }
    if (outcome === "skipped_opt_out") {
      return { sent: false, reason: "recipient_opted_out" };
    }
    return { sent: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`toolNotify.trySend failed [${source}]`, { phone, errMsg });
    return { sent: false, reason: "linq_send_failed", error: errMsg.slice(0, 200) };
  }
}

// Variant that goes through sendViaInteractionAgent (caraAgent voice + DND +
// supervisor) rather than raw sendToPhone. Useful for tools where Cara should
// say it in her own voice rather than relay a verbatim caregiver/client line.
export async function trySendViaCara(
  phone:   string,
  content: string,
  source:  string,
  opts:    { urgency?: "immediate" | "standard"; canDrop?: boolean } = {},
): Promise<NotifyOutcome> {
  if (!phone) {
    return { sent: false, reason: "missing_phone" };
  }
  try {
    const { sendViaInteractionAgent } = await import("../agents/caraAgent");
    await sendViaInteractionAgent(phone, {
      content,
      urgency:     opts.urgency ?? "standard",
      sourceAgent: source,
      canDrop:     opts.canDrop ?? false,
    });
    return { sent: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`toolNotify.trySendViaCara failed [${source}]`, { phone, errMsg });
    return { sent: false, reason: "cara_send_failed", error: errMsg.slice(0, 200) };
  }
}
