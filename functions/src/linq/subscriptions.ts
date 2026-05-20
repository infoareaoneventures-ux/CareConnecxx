/**
 * Linq Webhook Subscriptions API
 *
 * Manages CRUD for webhook subscriptions plus a one-time setup utility
 * that registers the Cara webhook URL and stores the signing secret.
 *
 * Usage (run once after deploy):
 *   import { ensureWebhookSubscription } from "./subscriptions";
 *   await ensureWebhookSubscription();
 */

import axios, { AxiosError } from "axios";
import * as admin from "firebase-admin";

const BASE_URL = process.env.LINQ_BASE_URL ?? "https://api.linqapp.com/api/partner/v3";

function headers() {
  return {
    Authorization: `Bearer ${process.env.LINQ_API_KEY ?? ""}`,
    "Content-Type": "application/json",
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type LinqWebhookEvent =
  | "message.sent"
  | "message.received"
  | "message.delivered"
  | "message.read"
  | "message.failed"
  | "message.edited"
  | "reaction.added"
  | "reaction.removed"
  | "chat.created"
  | "chat.group_name_updated"
  | "chat.group_icon_updated"
  | "chat.group_name_update_failed"
  | "chat.group_icon_update_failed"
  | "chat.typing_indicator.started"
  | "chat.typing_indicator.stopped"
  | "participant.added"
  | "participant.removed"
  | "phone_number.status_updated"
  | "call.initiated"
  | "call.ringing"
  | "call.answered"
  | "call.ended"
  | "call.failed"
  | "call.declined"
  | "call.no_answer";

export interface LinqWebhookSubscription {
  id:                string;
  target_url:        string;
  subscribed_events: LinqWebhookEvent[];
  phone_numbers?:    string[];
  is_active:         boolean;
  created_at:        string;
  updated_at:        string;
}

export interface CreateSubscriptionParams {
  target_url:        string;
  subscribed_events: LinqWebhookEvent[];
  phone_numbers?:    string[];
}

// ── Core events Cara needs ────────────────────────────────────────────────────

export const CARA_WEBHOOK_EVENTS: LinqWebhookEvent[] = [
  "message.sent",
  "message.received",
  "message.delivered",
  "message.read",
  "message.failed",
  "message.edited",
  "reaction.added",
  "reaction.removed",
  "chat.created",
  "chat.typing_indicator.started",
  "chat.typing_indicator.stopped",
  "participant.added",
  "participant.removed",
  "phone_number.status_updated",
];

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as AxiosError)?.response?.status;
      if ((status === 500 || status === 503) && i < attempts - 1) {
        await new Promise<void>((r) => setTimeout(r, Math.pow(2, i) * 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createSubscription(
  params: CreateSubscriptionParams
): Promise<LinqWebhookSubscription & { signing_secret: string }> {
  const res = await withRetry(() =>
    axios.post(`${BASE_URL}/webhook-subscriptions`, params, { headers: headers() })
  );
  return res.data as LinqWebhookSubscription & { signing_secret: string };
}

export async function listSubscriptions(): Promise<LinqWebhookSubscription[]> {
  const res = await withRetry(() =>
    axios.get(`${BASE_URL}/webhook-subscriptions`, { headers: headers() })
  );
  return (res.data?.subscriptions ?? res.data ?? []) as LinqWebhookSubscription[];
}

export async function getSubscription(id: string): Promise<LinqWebhookSubscription> {
  const res = await withRetry(() =>
    axios.get(`${BASE_URL}/webhook-subscriptions/${id}`, { headers: headers() })
  );
  return res.data as LinqWebhookSubscription;
}

export async function updateSubscription(
  id:     string,
  params: Partial<{
    target_url:        string;
    subscribed_events: LinqWebhookEvent[];
    phone_numbers:     string[] | null;
    is_active:         boolean;
  }>
): Promise<LinqWebhookSubscription> {
  const res = await withRetry(() =>
    axios.patch(`${BASE_URL}/webhook-subscriptions/${id}`, params, { headers: headers() })
  );
  return res.data as LinqWebhookSubscription;
}

export async function deleteSubscription(id: string): Promise<void> {
  await withRetry(() =>
    axios.delete(`${BASE_URL}/webhook-subscriptions/${id}`, { headers: headers() })
  );
}

// ── One-time setup ────────────────────────────────────────────────────────────

/**
 * Idempotent: registers the Cara webhook URL with Linq if not already present.
 * Persists the signing_secret to Firestore `system_config/linq_webhook`.
 * Run once after each deploy to a new environment.
 *
 * @param webhookUrl  Full HTTPS URL to the linqWebhook Cloud Function endpoint
 * @param events      Override the default CARA_WEBHOOK_EVENTS list
 */
export async function ensureWebhookSubscription(
  webhookUrl: string,
  events:     LinqWebhookEvent[] = CARA_WEBHOOK_EVENTS
): Promise<{ subscriptionId: string; isNew: boolean }> {
  const db = admin.firestore();

  // Check if we already have a subscription on record
  const configSnap = await db.collection("system_config").doc("linq_webhook").get();
  const existing   = configSnap.data();

  if (existing?.subscriptionId) {
    // Verify it still exists on Linq's side
    try {
      const sub = await getSubscription(existing.subscriptionId as string);
      if (!sub.is_active) {
        await updateSubscription(sub.id, { is_active: true });
      }
      console.info("ensureWebhookSubscription: existing subscription is active", sub.id);
      return { subscriptionId: sub.id, isNew: false };
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      if (status !== 404) throw err;
      // 404 — subscription was deleted on Linq's side, fall through to recreate
    }
  }

  // Check remote list to avoid duplicate target_urls
  const allSubs = await listSubscriptions();
  const match   = allSubs.find((s) => s.target_url === webhookUrl);

  if (match) {
    // Already registered from a previous run without a Firestore record
    await db.collection("system_config").doc("linq_webhook").set(
      { subscriptionId: match.id, targetUrl: webhookUrl, updatedAt: new Date().toISOString() },
      { merge: true }
    );
    return { subscriptionId: match.id, isNew: false };
  }

  // Create a fresh subscription
  const sub = await createSubscription({
    target_url:        webhookUrl,
    subscribed_events: events,
  });

  // Persist subscription ID and signing_secret (signing_secret is shown only on creation)
  await db.collection("system_config").doc("linq_webhook").set({
    subscriptionId: sub.id,
    targetUrl:      webhookUrl,
    signingSecret:  sub.signing_secret,
    createdAt:      new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
  });

  console.info("ensureWebhookSubscription: created new subscription", sub.id);
  return { subscriptionId: sub.id, isNew: true };
}

/**
 * Pause or resume all Cara webhook subscriptions.
 * Useful during deployments or maintenance windows.
 */
export async function setSubscriptionActive(
  subscriptionId: string,
  active:         boolean
): Promise<void> {
  await updateSubscription(subscriptionId, { is_active: active });
  const db = admin.firestore();
  await db.collection("system_config").doc("linq_webhook").set(
    { isActive: active, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}
