import { sendToPhone } from "../linq/client";

// Structured outcome for downstream sends triggered by an MCP tool. The point
// of this helper is to stop hiding send failures inside `.catch(() => {})` —
// tools surface the outcome in their response so the qaAgent system prompt
// can tell Cara *"action completed but the message didn't go through"* instead
// of *"I let them know."*

export type NotifyOutcome =
  | { sent: true }
  | { sent: false; reason: string; error?: string };

export async function trySend(
  phone:   string,
  message: string,
  source:  string,
): Promise<NotifyOutcome> {
  if (!phone) {
    return { sent: false, reason: "missing_phone" };
  }
  try {
    await sendToPhone(phone, message);
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
