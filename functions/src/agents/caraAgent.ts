import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { AgentSession, sendMessage, LinqMessage, LinqService } from "../linq/client";
import { getPreferences, isInDND, isActiveHour, validatedTz, CaraPreferences } from "../memory/preferences";
import { supervise } from "../safety/supervisor";
import { logAudit } from "../observability/auditLog";
import { buildConsentAuditRecord } from "../observability/consentAudit";
import { claimOutboundSend } from "../utils/outboundLedger";
import { evaluateProactiveCap, MAX_PROACTIVE_PER_DAY, type ProactiveTally } from "./proactiveCap";

const db = admin.firestore();

// ── AgentOutput — returned by execution agents, consumed by Interaction Agent ──

export interface AgentOutput {
  content:     string;
  urgency:     "immediate" | "standard" | "low";
  sourceAgent: string;
  canDrop:     boolean; // if false, always send regardless of DND/recency
  // Exempt this send from the global per-user daily proactive cap while STILL
  // honoring quiet hours / DND (canDrop: true). Used by transactional in-shift
  // updates, which are part of an active service the family opted into and can
  // tune conversationally — one long visit would otherwise exhaust the 3/day cap
  // by mid-afternoon. Volume is bounded by the feature's own per-shift ceiling.
  bypassDailyCap?: boolean;
  // Force a Linq protocol for compliance/deliverability-critical sends (e.g.
  // "SMS" for billing and emergency alerts so they never depend on iMessage).
  // Omit for the default iMessage → RCS → SMS auto-selection.
  preferredService?: LinqService;
  /** Internal receipt hook for durable workflows that must correlate provider status. */
  onTransportReceipt?: (messageId: string) => void | Promise<void>;
  // A transport failure normally gets silently dead-lettered into Linq's own
  // generic redelivery queue (sendMessage returns as if nothing failed). That
  // doubles delivery for a caller like the billing-approval-notice outbox that
  // ALSO runs its own outer retry loop — Linq's queue redelivers once, the
  // caller's own retry redelivers again, both unaware of each other. Set this
  // for any caller with its own idempotent outer retry so a transport failure
  // throws back to it instead, leaving exactly one system owning retry.
  noQueueOnFailure?: boolean;
}

// ── Wait tool — decides whether to send a non-immediate message ───────────────

async function shouldSend(
  output: AgentOutput,
  phone:  string,
  prefs:  CaraPreferences,
  session: Record<string, unknown>
): Promise<boolean> {
  if (output.urgency === "immediate") return true;
  if (prefs.dndEnabled && isInDND(prefs)) return false;
  if (!isActiveHour(prefs)) return false;

  const lastSentAt = session.lastMessageSentAt as string | undefined;
  if (lastSentAt) {
    const minutesSinceLast = (Date.now() - new Date(lastSentAt).getTime()) / 60_000;
    if (minutesSinceLast < 5 && output.urgency === "low") return false;
  }

  // LLM judgment for standard urgency
  if (output.urgency === "standard") {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      // 2026-09-13 live incident: this used to pass the raw UTC hour with no
      // timezone framing at all. For any US family, UTC morning hours (0-8)
      // are actually their PREVIOUS evening (5pm-1am local) — the model had
      // no way to know that and could read "hour 5" as "5am, too early",
      // silently holding back messages during a family's normal evening.
      // isActiveHour (above) already gated on the real local window; this is
      // just giving the LLM step the same correct clock instead of a raw,
      // unlabeled UTC number it has no basis to interpret.
      const tz = validatedTz(prefs.timezone || "America/Los_Angeles");
      const localTime = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: tz,
      }).format(new Date());
      const raw = await quickComplete(
        "You decide if a care update should be sent to a family right now.\n" +
          "Consider: Is this new info? Is it timely? Would a human coordinator send this now?\n" +
          "Reply SEND or WAIT — one word only.",
        `Message: "${output.content.slice(0, 200)}"\n` +
          `Last sent: ${lastSentAt ?? "never"}\n` +
          `Current local time for this family: ${localTime} (${tz})`,
        { maxTokens: 5, signal: controller.signal },
      );
      clearTimeout(timer);
      return raw.trim().toUpperCase() === "SEND";
    } catch {
      console.warn("shouldSend timeout — holding message to prevent spam");
      return false; // safe default: hold on timeout, not send
    }
  }

  return true;
}

// Matches both explicit URLs (https://example.com/path) and bare hostnames
// the matching/onboarding agents sometimes produce when the LLM drops the
// scheme to save SMS characters (careconnex-d4c8b.web.app/caregiver/abc).
// Without https://, iMessage won't auto-link the URL — see issue where Evia's
// caregiver-profile links rendered as plain text.
const URL_RE =
  /\b(?:https?:\/\/[^\s<>"'`)\]]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|app|net|org|io|co|us|web\.app|dev|ai)(?:\/[^\s<>"'`)\]]*)?)/gi;

// Trailing punctuation that's almost always sentence punctuation, not part
// of the URL. Stripped after the regex grabs greedily.
const URL_TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/;

interface UrlMatch { start: number; end: number; url: string; }

function findUrls(text: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    let raw = m[0];
    let end = m.index + raw.length;
    const trim = raw.match(URL_TRAILING_PUNCT);
    if (trim) {
      raw = raw.slice(0, raw.length - trim[0].length);
      end -= trim[0].length;
    }
    if (!raw) continue;
    matches.push({ start: m.index, end, url: raw });
  }
  return matches;
}

/**
 * Ensure URLs in the text have an https:// scheme so iMessage/RCS auto-link
 * them. Pure text rewrite — Linq's /messages endpoint rejects mixed
 * text+link part bodies, so we normalize the string and let the client
 * auto-detect URLs the way it normally would.
 *
 * Always returns a string. The mixed-return type is kept for the existing
 * call sites (which pass the result straight to sendMessage).
 */
export function buildClickableMessage(text: string): string | LinqMessage {
  const matches = findUrls(text);
  if (matches.length === 0) return text;
  // Walk the matches in reverse so earlier offsets stay valid as we splice.
  let out = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, url } = matches[i];
    if (/^https?:\/\//i.test(url)) continue;
    out = `${out.slice(0, start)}https://${url}${out.slice(end)}`;
  }
  return out;
}

// Split long messages at sentence boundaries, keeping each chunk under maxLen.
// URL-aware: never splits in the middle of a URL — if the natural cut falls
// inside one, the cut moves to the character before the URL starts.
function splitMessage(text: string, maxLen = 1000): string[] {
  if (text.length <= maxLen) return [text];
  const urls = findUrls(text);
  const insideUrl = (pos: number) =>
    urls.find(u => pos > u.start && pos < u.end);

  const chunks: string[] = [];
  let remaining = text;
  let offset = 0;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf(". ", maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < 0) cut = maxLen;
    // If the cut lands inside a URL, back up to just before the URL starts.
    const u = insideUrl(offset + cut);
    if (u) cut = Math.max(0, u.start - offset - 1);
    if (cut <= 0) cut = maxLen; // fallback — shouldn't happen for sane inputs
    chunks.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
    offset += cut + 1;
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── sendViaInteractionAgent — the ONLY path for user-facing messages ──────────

// Resolves true only when the message was actually handed to the transport —
// every suppression path (opt-out, wait tool, daily cap, dedup) resolves false
// so callers that meter real deliveries (e.g. the in-shift per-shift ceiling)
// don't count phantom sends. Existing callers that ignore the result are
// unaffected.
export async function sendViaInteractionAgent(
  phone:  string,
  output: AgentOutput
): Promise<boolean> {
  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return false;

  const session = sessionSnap.data() as AgentSession & Record<string, unknown>;
  const consentSnapshot = { optedOut: session.optedOut, optedInAt: (session as any).optedInAt };
  if (session.optedOut) {
    // U6: record the suppressed send for TCPA consent auditing.
    db.collection("consent_audit_log").add(
      buildConsentAuditRecord(phone, output.sourceAgent, "suppressed_opted_out", consentSnapshot, new Date().toISOString()),
    ).catch(() => {});
    return false;
  }

  const targetChatId = session.chatId;

  const prefs = await getPreferences(phone);

  // When this send is an allowed proactive nudge, the tally to persist after it
  // actually goes out (null = not subject to the daily cap). Written at the end
  // alongside lastMessageSentAt so a later dedup/failure doesn't burn budget.
  let proactiveTallyToPersist: ProactiveTally | null = null;

  // Wait tool judgment — may suppress non-critical messages
  if (output.canDrop) {
    const send = await shouldSend(output, phone, prefs, session as Record<string, unknown>);
    if (!send) {
      logAudit({
        eventType: "message_sent",
        userId:    phone,
        phone,
        data: { suppressed: true, reason: "wait_tool", sourceAgent: output.sourceAgent, preview: output.content.slice(0, 50) },
      }).catch(() => {});
      return false;
    }

    // Global per-user daily cap across ALL proactive sources. shouldSend judged
    // "send now?"; this enforces "enough today?". Urgent/immediate bypasses, as
    // do transactional in-shift updates (bypassDailyCap) — they cleared the
    // quiet-hours/DND check in shouldSend above, they just don't count against
    // the daily proactive budget.
    if (output.urgency !== "immediate" && !output.bypassDailyCap) {
      const today = new Date().toISOString().slice(0, 10);
      const cap = evaluateProactiveCap(
        (session as Record<string, unknown>).proactiveSentToday as ProactiveTally | undefined,
        today,
      );
      if (!cap.allowed) {
        logAudit({
          eventType: "message_sent",
          userId:    phone,
          phone,
          data: { suppressed: true, reason: "daily_cap", cap: MAX_PROACTIVE_PER_DAY, sourceAgent: output.sourceAgent, preview: output.content.slice(0, 50) },
        }).catch(() => {});
        return false;
      }
      proactiveTallyToPersist = cap.next;
    }
  }

  // Content-hash dedup: a redelivered inbound can drive an identical outbound.
  // Suppress an exact duplicate to the same chat within a short window (all
  // urgencies — a doubled critical message is a redelivery artifact). Distinct
  // content, or the same content sent later, still goes out.
  // Fail open (like the supervisor call below): if the dedup claim throws
  // (e.g. Firestore unavailable) we send anyway rather than letting Evia go
  // dark — a rare duplicate is far less harmful than a dropped message.
  let isDuplicate = false;
  try {
    isDuplicate = !(await claimOutboundSend(phone, targetChatId, output.content));
  } catch (err) {
    console.error("caraAgent: outbound dedup claim failed, sending anyway (fail-open)", err instanceof Error ? err.message : String(err));
  }
  if (isDuplicate) {
    logAudit({
      eventType: "message_sent",
      userId:    phone,
      phone,
      data: { suppressed: true, reason: "duplicate", sourceAgent: output.sourceAgent, preview: output.content.slice(0, 50) },
    }).catch(() => {});
    return false;
  }

  // Run through supervisor (which also lints internally). If supervisor throws
  // we fail-open (send unsupervised) so Evia doesn't go dark — but record an
  // admin_alert so a sustained supervisor outage gets noticed instead of just
  // showing up in logs.
  const safe = await supervise(output.content, { phone }).catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("caraAgent: supervisor threw, sending message unsupervised", errMsg);
    const minuteBucket = new Date().toISOString().slice(0, 16);
    db.collection("admin_alerts").add({
      type:        "supervisor_fail_open",
      phone,
      error:       errMsg.slice(0, 500),
      preview:     output.content.slice(0, 200),
      sourceAgent: output.sourceAgent,
      dedupeKey:   `supervisor_fail_open:${minuteBucket}`,
      severity:    "high",
      resolved:    false,
      createdAt:   new Date().toISOString(),
    }).catch(() => {/* non-critical */});
    return output.content;
  });

  // Send in chunks with 1s delay between. Each chunk is run through
  // buildClickableMessage so any URLs become structured Linq link parts —
  // otherwise iMessage won't auto-link URLs that lost their https:// scheme.
  const chunks = splitMessage(safe);
  const sendOpts = {
    ...(output.preferredService ? { preferredService: output.preferredService } : {}),
    ...(output.noQueueOnFailure ? { _noQueue: true } : {}),
  };
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise<void>(r => setTimeout(r, 1000));
    const receipt = await sendMessage(targetChatId, buildClickableMessage(chunks[i]), sendOpts);
    if (receipt.message_id && output.onTransportReceipt) {
      await output.onTransportReceipt(receipt.message_id);
    }
  }

  // Update lastMessageSentAt, and the proactive daily tally if this was a capped
  // nudge that actually went out (incremented only on a real send).
  const sessionUpdate: Record<string, unknown> = { lastMessageSentAt: new Date().toISOString() };
  if (proactiveTallyToPersist) sessionUpdate.proactiveSentToday = proactiveTallyToPersist;
  db.collection("agent_sessions").doc(phone)
    .update(sessionUpdate)
    .catch((err) => console.error("caraAgent: failed to update session send markers", err));

  // HIPAA audit log
  logAudit({
    eventType: "message_sent",
    userId:    phone,
    phone,
    data: { preview: safe.slice(0, 100), urgency: output.urgency, sourceAgent: output.sourceAgent, chatId: targetChatId },
  }).catch((err) => console.error("caraAgent: audit log write failed", err));

  // U6: TCPA consent audit — record that this proactive message went out and
  // the consent state at send time.
  db.collection("consent_audit_log").add(
    buildConsentAuditRecord(phone, output.sourceAgent, "sent", consentSnapshot, new Date().toISOString()),
  ).catch(() => {});
  return true;
}
