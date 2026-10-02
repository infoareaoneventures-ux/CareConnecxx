import * as admin from "firebase-admin";
import { createCaraOpsAlert } from "./caraOpsAlerts";

export type ProviderErrorClass = "billing" | "auth" | "rate_limit" | "timeout" | "other";

// Best-effort classification of a provider (Anthropic/OpenAI) call failure so
// ops can tell "credit exhaustion" apart from "vendor hiccup" without reading
// a stack trace. Order matters: billing/auth/rate_limit are checked before the
// generic timeout/other bucket because some SDK errors carry both a status
// code and a message — the more specific signal wins.
export function classifyProviderError(err: unknown): ProviderErrorClass {
  const status = extractStatus(err);
  const message = extractMessage(err).toLowerCase();

  // Substring (not \b word-boundary) matching on purpose: real provider error
  // codes use underscores (OpenAI's "insufficient_quota"), which regex word
  // boundaries treat as part of the word and fail to isolate.
  if (
    status === 402 ||
    /credit|quota|insufficient|billing/.test(message)
  ) {
    return "billing";
  }

  if (status === 401 || /invalid api key/.test(message)) {
    return "auth";
  }

  if (status === 429) {
    return "rate_limit";
  }

  if (/timeout|timed out|abort/.test(message)) {
    return "timeout";
  }

  return "other";
}

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.response?.status === "number") return candidate.response.status;
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err ?? "");
}

export interface RaiseProviderFailureAlertParams {
  phone?: string;
  provider?: string;
  model?: string;
  error: unknown;
  /** True when a second provider is taking over THIS call (OpenAI → Anthropic fallback):
   *  the alert + founder page still go out, but system-wide degraded mode is NOT set —
   *  Evia is answering, so holding every reminder would be wrong (2026-10-01 live-caught:
   *  four days of held interview reminders released at once). */
  hasFallback?: boolean;
}

// Best-effort alerting sink for a provider-call failure: writes a typed
// admin_alerts doc and, for the classes that mean "Evia is silently degraded
// for everyone" (billing/auth), best-effort SMS's the founder via ADMIN_PHONE.
// Never throws — a failed alert must not break the user's turn.
export async function raiseProviderFailureAlert(params: RaiseProviderFailureAlertParams): Promise<void> {
  try {
    const providerErrorClass = classifyProviderError(params.error);
    const severity = providerErrorClass === "billing" || providerErrorClass === "auth" ? "critical" : "medium";
    const errorText = String(params.error).slice(0, 300);

    const wrote = await createCaraOpsAlert({
      type: "provider_failure",
      severity,
      phone: params.phone,
      error: errorText,
      source: "cara",
      context: {
        providerErrorClass,
        provider: params.provider,
        model: params.model,
      },
    }).catch(() => false);

    if (!wrote) {
      // createCaraOpsAlert already swallows its own errors and logs; fall
      // back to a raw write in case createCaraOpsAlert's shape rejected the
      // input for some reason, so the alert isn't lost outright.
      await admin
        .firestore()
        .collection("admin_alerts")
        .add({
          type: "provider_failure",
          providerErrorClass,
          provider: params.provider,
          model: params.model,
          phone: params.phone,
          error: errorText,
          severity,
          createdAt: new Date().toISOString(),
          resolved: false,
        })
        .catch(() => {});
    }

    if (providerErrorClass === "billing" || providerErrorClass === "auth") {
      await smsAdmin().catch(() => {});
      // Billing/auth on the ONLY provider means every turn is failing — flip
      // system-wide degraded mode so users get one honest notice instead of
      // per-turn snag spam, and proactive sends hold until recovery (the next
      // successful turn clears the flag). When a fallback provider is carrying
      // the call, Evia is not degraded: page the founder, hold nothing.
      if (!params.hasFallback) {
        await import("./systemStatus")
          .then((m) => m.setSystemDegraded(`provider ${providerErrorClass}: ${errorText.slice(0, 120)}`))
          .catch(() => {});
      }
    }
  } catch {
    // Alerting must never break the user turn.
  }
}

async function smsAdmin(): Promise<void> {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) return;

  const { sendToPhone } = await import("../linq/client");
  await sendToPhone(
    adminPhone,
    "Evia: the AI provider is failing (billing/auth) — users are getting fallback replies. Check the provider console.",
  ).catch(() => {});
}
