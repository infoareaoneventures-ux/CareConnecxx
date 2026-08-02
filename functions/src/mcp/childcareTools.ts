// ── Childcare MCP tool pack (plan 2026-07-22-002, U10 / R51-R52, AE19) ───────
//
// Family-side Evia tools for classified childcare turns. Every tool maps onto
// the EXISTING U2-U9 server logic (guardianAuthority.checkAuthority,
// childProfileRepository, bookingCallables cores) — no parallel childcare
// implementation exists here.
//
// Trust model (R51 — never trust the envelope alone at mutation time):
//   • `careVertical` on the input is stamped AUTHORITATIVELY by qaAgent from
//     the server-resolved session (it overwrites any model-supplied value).
//     A senior/unclassified turn can therefore never reach a handler body:
//     the vertical guard fails closed first.
//   • Every handler ALSO re-runs action-time authorization inside the shared
//     cores (checkAuthority per child, provider-eligibility recheck, runtime
//     flags recheck) — a forged or stale envelope cannot authorize a mutation.
//   • Unknown childcare-context tools fail closed in qaAgent's dispatch guard;
//     this module only ever executes the names in CHILDCARE_TOOL_NAMES.
//
// Evidence (R52 / actionEvidence pattern): mutation tools return authoritative
// post-state from a FRESH booking read — Evia may claim canceled/changed only
// from that evidence, never from handler success alone.

import * as admin from "firebase-admin";
import type { McpTool } from "./server";
// NOTE: guardianAuthority / childProfileRepository are imported LAZILY inside
// the handlers — their module graphs reach auditLog's module-level
// admin.firestore(), and this module's NAME SETS must stay importable by the
// deterministic eval runner (no Firebase app) and pure test suites.
import type { GuardianAuthorityDoc } from "../childcare/guardianAuthority";
import { getChildcareFlags } from "../config/featureFlags";
import { appLink } from "../config/appUrl";
import { verifyPostcondition } from "../agents/actionEvidence";
// NOTE: signupIngress (CHILDCARE_PROFILE_PATH) is imported LAZILY inside the
// resend_childcare_links handler — its module graph reaches auditLog's
// module-level admin.firestore(), which the deterministic eval runner (no
// Firebase app) must never load.

type Db = admin.firestore.Firestore;

// Local copy of the server's tool-error envelope (server.ts imports THIS
// module, so importing the helper from server.ts would create a cycle).
type ChildcareToolErrorCode =
  | "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" | "UNAVAILABLE" | "CONFLICT";
function toolError(code: ChildcareToolErrorCode, message: string) {
  return { _toolError: true, success: false, code, message };
}

/** The complete family-side childcare tool pack (R51). */
export const CHILDCARE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_my_children",
  "get_childcare_bookings",
  "get_childcare_coordination_summary",
  "request_childcare_booking_change",
  "cancel_childcare_booking",
  "resend_childcare_links",
]);

/**
 * Shared/loop-control tools ALSO permitted on a childcare turn (they carry no
 * recipient data). Everything else — every senior tool — fails closed.
 */
export const CHILDCARE_SHARED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "complete_task",
  "write_todos",
  "create_support_ticket",
]);

export function isChildcareTool(name: string): boolean {
  return CHILDCARE_TOOL_NAMES.has(name);
}

/** True when `name` may be dispatched at all during a childcare turn. */
export function isAllowedInChildcareTurn(name: string): boolean {
  return CHILDCARE_TOOL_NAMES.has(name) || CHILDCARE_SHARED_TOOL_NAMES.has(name);
}

export const CHILDCARE_TOOL_DEFS: McpTool[] = [
  {
    name: "list_my_children",
    description:
      "List the children this parent/guardian may view (display labels and age bands only — " +
      "no child PII). Authority-checked per child at call time.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_childcare_bookings",
    description:
      "Current childcare bookings for this family: status, provider display name, recipient " +
      "display label, and whether a schedule change is pending.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_childcare_coordination_summary",
    description:
      "Coordination summary for ONE childcare booking: verified status, schedule, provider, " +
      "and pending-change state. Use before promising anything about a booking.",
    input_schema: {
      type: "object",
      properties: { bookingId: { type: "string", description: "The childcare booking id" } },
      required: ["bookingId"],
    },
  },
  {
    name: "request_childcare_booking_change",
    description:
      "Propose a schedule change on a childcare booking. Pre-acceptance changes apply " +
      "immediately; post-acceptance changes stay PENDING until the provider re-accepts — " +
      "never tell the family a pending change is applied.",
    input_schema: {
      type: "object",
      properties: {
        bookingId: { type: "string" },
        schedule: {
          type: "object",
          description:
            "New schedule: { dates: [{ date: 'YYYY-MM-DD', startTime: 'HH:MM', endTime: 'HH:MM' }], recurring: null }",
        },
        idempotencyKey: { type: "string", description: "Stable key for this change request" },
      },
      required: ["bookingId", "schedule", "idempotencyKey"],
    },
  },
  {
    name: "cancel_childcare_booking",
    description:
      "Cancel a childcare booking after the family explicitly confirms. Revokes provider " +
      "safety/conversation access and applies the cancellation policy.",
    input_schema: {
      type: "object",
      properties: { bookingId: { type: "string" } },
      required: ["bookingId"],
    },
  },
  {
    name: "resend_childcare_links",
    description:
      "Get the family's secure childcare dashboard link (child profiles, documents, details). " +
      "Send this whenever child-sensitive information needs to be added or changed — those " +
      "details never travel over text.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

// ── Handler plumbing ─────────────────────────────────────────────────────────

interface ChildcareToolContext {
  actorUid: string;
  db: Db;
  now: Date;
}

function mapChildcareToolError(err: unknown) {
  if (err && typeof err === "object") {
    const httpsCode = (err as { code?: unknown }).code;
    const details = (err as { details?: { code?: string } }).details;
    if (httpsCode === "permission-denied") return toolError("PERMISSION_DENIED", "You don't have permission for that childcare action.");
    if (httpsCode === "failed-precondition") {
      return toolError("UNAVAILABLE", details?.code === "childcare_disabled"
        ? "Childcare features are currently unavailable."
        : "That childcare action isn't possible right now.");
    }
    if (httpsCode === "invalid-argument") return toolError("INVALID_INPUT", "That childcare request was malformed.");
    if ((err as { name?: string }).name === "GuardianAuthorityError") {
      return toolError("PERMISSION_DENIED", "You don't have permission for that childcare action.");
    }
    const name = (err as { name?: string }).name;
    if (name === "BookingPolicyError") {
      const policyCode = (err as { code?: string }).code;
      if (policyCode === "conflict") return toolError("CONFLICT", "That time conflicts with an existing booking.");
      return toolError("INVALID_INPUT", "That change isn't allowed from the booking's current state.");
    }
  }
  console.error("childcareTools: tool failed", {
    reason: err instanceof Error ? err.message.slice(0, 160) : "unknown",
  });
  return toolError("UNAVAILABLE", "Childcare service hiccup — tell the family you couldn't confirm it and to try again shortly.");
}

async function loadOwnedChildcareBooking(
  ctx: ChildcareToolContext,
  bookingId: string,
): Promise<Record<string, unknown> | { _toolError: true; success: false; code: ChildcareToolErrorCode; message: string }> {
  const snap = await ctx.db.collection("booking_requests").doc(bookingId).get();
  const booking = snap.exists ? (snap.data() as Record<string, unknown>) : null;
  // Enumeration-safe: absent, non-child, and foreign bookings are identical.
  if (!booking || booking.careVertical !== "child" || booking.clientId !== ctx.actorUid) {
    return toolError("NOT_FOUND", "No childcare booking with that id is on this account.");
  }
  return booking;
}

/** Fresh-read post-state evidence (R52/actionEvidence): status straight from Firestore. */
async function freshBookingEvidence(
  ctx: ChildcareToolContext,
  bookingId: string,
  expectedStatuses: string[],
  operationId?: string,
) {
  return verifyPostcondition(
    "childcare_booking_state",
    {
      kind: "fresh_read",
      description: "booking has an expected authoritative status",
      targetRef: () => `booking_requests/${bookingId}`,
      verify: async (_input, _output, { db }) => {
        const snap = await db.collection("booking_requests").doc(bookingId).get();
        const status = snap.exists ? String((snap.data() ?? {}).status ?? "unknown") : "missing";
        return {
          ok: expectedStatuses.includes(status),
          observed: { status },
        };
      },
    },
    { bookingId, expectedStatuses },
    null,
    {
      db: ctx.db,
      now: ctx.now,
      careVertical: "child",
      operationId,
      idempotencyKey: operationId,
    },
  );
}

function summarizeSchedule(schedule: unknown): Record<string, unknown> {
  const s = (schedule ?? {}) as { dates?: unknown; recurring?: unknown };
  return {
    dates: Array.isArray(s.dates)
      ? (s.dates as Array<Record<string, unknown>>).slice(0, 10).map((d) => ({
          date: String(d.date ?? ""), startTime: String(d.startTime ?? ""), endTime: String(d.endTime ?? ""),
        }))
      : [],
    recurring: s.recurring ?? null,
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Execute one childcare tool. Returns null when `name` is not a childcare
 * tool (the server's switch continues to the senior handlers). Every handler
 * fails closed unless the input carries the server-stamped childcare vertical
 * AND an authenticated actor id.
 */
export async function executeChildcareTool(
  name: string,
  input: Record<string, unknown>,
  opts: { db?: Db; now?: Date } = {},
): Promise<Record<string, unknown> | null> {
  if (!CHILDCARE_TOOL_NAMES.has(name)) return null;

  // R51 vertical guard: only a server-classified childcare turn may reach a
  // childcare tool (qaAgent stamps this from the session; the model cannot).
  if (input.careVertical !== "child") {
    return toolError("PERMISSION_DENIED", "Childcare tools are only available in a childcare conversation.");
  }
  const actorUid = String(input.userId ?? input.clientId ?? "").trim();
  if (!actorUid) return toolError("PERMISSION_DENIED", "No authenticated family account on this conversation.");

  const ctx: ChildcareToolContext = {
    actorUid,
    db: opts.db ?? admin.firestore(),
    now: opts.now ?? new Date(),
  };

  // Emergency-off / disabled (R61): the runtime flags are re-read INSIDE every
  // tool call — a mid-conversation flip takes effect on the next tool use.
  const flags = await getChildcareFlags({ db: ctx.db }).catch(() => null);
  if (!flags?.enabled) {
    return toolError("UNAVAILABLE", "Childcare features are currently unavailable. Direct the family to eviacares.com support for anything urgent.");
  }

  try {
    switch (name) {
      case "list_my_children": {
        const { checkAuthority, listAuthoritiesForAdult } = await import("../childcare/guardianAuthority");
        const { getChildProfile } = await import("../data/childProfileRepository");
        const authorities: GuardianAuthorityDoc[] = await listAuthoritiesForAdult(ctx.actorUid, ctx.db);
        const children: Array<Record<string, unknown>> = [];
        for (const authority of authorities) {
          if (!authority?.childId) continue;
          // Action-time recheck (never the envelope alone): live state/expiry.
          const decision = await checkAuthority(ctx.actorUid, authority.childId, "view", { db: ctx.db, now: ctx.now });
          if (!decision.allowed) continue;
          const profile = await getChildProfile(authority.childId, ctx.db).catch(() => null);
          if (!profile || profile.state !== "active") continue;
          children.push({
            childId: profile.childId,
            displayLabel: profile.displayLabel,
            ageBand: profile.ageBand,
            myScopes: authority.scopes,
          });
        }
        return { success: true, children, note: "Display labels and age bands only — full child details live in the secure dashboard." };
      }

      case "get_childcare_bookings": {
        const snap = await ctx.db.collection("booking_requests")
          .where("clientId", "==", ctx.actorUid)
          .get();
        const bookings = snap.docs
          .map((d) => (d.data() ?? {}) as Record<string, unknown>)
          .filter((b) => b.careVertical === "child")
          .map((b) => ({
            bookingId: String(b.bookingId ?? ""),
            status: String(b.status ?? ""),
            caregiverName: String(b.caregiverName ?? ""),
            recipientLabel: String(b.recipientLabel ?? ""),
            pendingChange: !!b.pendingChange,
          }));
        return { success: true, bookings };
      }

      case "get_childcare_coordination_summary": {
        const bookingId = String(input.bookingId ?? "").trim();
        if (!bookingId) return toolError("INVALID_INPUT", "bookingId is required");
        const booking = await loadOwnedChildcareBooking(ctx, bookingId);
        if ((booking as { _toolError?: boolean })._toolError) return booking as Record<string, unknown>;
        const b = booking as Record<string, unknown>;
        // Cross-child denial: the actor must hold LIVE view scope for every
        // child on the booking (ownership of the booking doc is not enough).
        const { checkAuthority } = await import("../childcare/guardianAuthority");
        for (const childId of (Array.isArray(b.childIds) ? (b.childIds as string[]) : [])) {
          const decision = await checkAuthority(ctx.actorUid, childId, "view", { db: ctx.db, now: ctx.now });
          if (!decision.allowed) return toolError("PERMISSION_DENIED", "You don't currently have access to this booking's children.");
        }
        return {
          success: true,
          bookingId,
          status: String(b.status ?? ""),
          statusIsAuthoritative: true,
          caregiverName: String(b.caregiverName ?? ""),
          recipientLabel: String(b.recipientLabel ?? ""),
          schedule: summarizeSchedule(b.schedule),
          pendingChange: b.pendingChange
            ? { pending: true, note: "A schedule change is awaiting the provider's response — it is NOT applied yet." }
            : { pending: false },
        };
      }

      case "request_childcare_booking_change": {
        const bookingId = String(input.bookingId ?? "").trim();
        const idempotencyKey = String(input.idempotencyKey ?? "").trim();
        if (!bookingId || !idempotencyKey) return toolError("INVALID_INPUT", "bookingId and idempotencyKey are required");
        if (!input.schedule || typeof input.schedule !== "object") {
          return toolError("INVALID_INPUT", "schedule is required: { dates: [{ date, startTime, endTime }], recurring: null }");
        }
        const { requestChildcareBookingChangeCore } = await import("../childcare/bookingCallables");
        const result = await requestChildcareBookingChangeCore(ctx.actorUid, {
          bookingId,
          changeKey: idempotencyKey.slice(0, 128),
          schedule: input.schedule,
        }, { db: ctx.db, now: ctx.now });
        const expectedStatuses = result.pending
          ? ["accepted", "confirmed"]
          : ["requested"];
        return {
          ...result,
          evidence: await freshBookingEvidence(
            ctx,
            bookingId,
            expectedStatuses,
            String(input._boundOperationId ?? input.idempotencyKey ?? "") || undefined,
          ),
        };
      }

      case "cancel_childcare_booking": {
        const bookingId = String(input.bookingId ?? "").trim();
        if (!bookingId) return toolError("INVALID_INPUT", "bookingId is required");
        const { cancelChildcareBookingCore } = await import("../childcare/bookingCallables");
        const result = await cancelChildcareBookingCore(ctx.actorUid, bookingId, { db: ctx.db, now: ctx.now });
        return {
          ...result,
          evidence: await freshBookingEvidence(
            ctx,
            bookingId,
            ["canceled"],
            String(input._boundOperationId ?? "") || undefined,
          ),
        };
      }

      case "resend_childcare_links": {
        const { CHILDCARE_PROFILE_PATH } = await import("../childcare/signupIngress");
        return {
          success: true,
          link: appLink(CHILDCARE_PROFILE_PATH),
          note: "Secure childcare dashboard link — include it in your reply. Child details are updated there, never over text.",
        };
      }

      default:
        return toolError("NOT_FOUND", `Unknown childcare tool: ${name}`);
    }
  } catch (err) {
    return mapChildcareToolError(err);
  }
}
