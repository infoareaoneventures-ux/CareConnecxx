// ── Admin assist queue (2026-10-22) ──────────────────────────────────────────
//
// The admin page can't call a new public Cloud Function (GCP org policy, see
// adminAdvanceQueue.ts), so it writes a request here and this trigger acts:
//   request_consent — park "Reply YES to allow" on the person's session + text it
//   end_consent     — the admin pressed Stop (window closed, person told)
//   send_link       — one of the link-only steps, sent by Evia the usual way
//                     (sendOnboardingLink: identity / membership / background
//                     check consent / payout setup / photo upload)
// Every request records who asked (adminUid/adminName) and lands in the audit
// log for that person. The doc gets processedAt + error so the page can show
// what happened.
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

export type AdminAssistQueueType = "request_consent" | "end_consent" | "send_link" | "acted";
export const ADMIN_ASSIST_LINK_KINDS = [
  "client_identity", "client_payment", "caregiver_membership", "caregiver_background_check", "caregiver_payouts", "caregiver_photo",
] as const;
export type AdminAssistLinkKind = typeof ADMIN_ASSIST_LINK_KINDS[number];

export interface AdminAssistQueueDoc {
  type: AdminAssistQueueType;
  uid: string;
  role: "client" | "caregiver";
  adminUid: string;
  adminName: string;
  linkKind?: AdminAssistLinkKind;
  /** type "acted": what the admin just did on the person's pages (services/api.ts recordActedForPerson). */
  kind?: string;
  summary?: string;
  extra?: Record<string, unknown>;
}

export function linkKindAllowedForRole(kind: string, role: "client" | "caregiver"): kind is AdminAssistLinkKind {
  if (!(ADMIN_ASSIST_LINK_KINDS as readonly string[]).includes(kind)) return false;
  return role === "client" ? kind.startsWith("client_") : kind.startsWith("caregiver_");
}

async function resolvePerson(uid: string, role: "client" | "caregiver"): Promise<{ phone?: string; firstName?: string }> {
  const col = role === "caregiver" ? "caregivers" : "users";
  const doc = (await db.collection(col).doc(uid).get()).data() ?? {};
  let phone = typeof doc.phone === "string" ? doc.phone : undefined;
  if (!phone && role === "caregiver") phone = (await db.collection("users").doc(uid).get()).data()?.phone;
  if (!phone) phone = (await admin.auth().getUser(uid).catch(() => null))?.phoneNumber ?? undefined;
  const firstName = typeof doc.firstName === "string" && doc.firstName.trim()
    ? doc.firstName.trim()
    : typeof doc.name === "string" ? doc.name.trim().split(/\s+/)[0] : undefined;
  return { phone, firstName };
}

export const processAdminAssistQueue = functions.firestore
  .document("adminAssistQueue/{docId}")
  .onCreate(async (snap) => {
    const data = snap.data() as AdminAssistQueueDoc;
    const done = (error: string | null) => snap.ref.update({ processedAt: admin.firestore.FieldValue.serverTimestamp(), error });
    try {
      if (!data.uid || !data.adminUid || (data.role !== "client" && data.role !== "caregiver")) { await done("Missing uid, role or adminUid"); return; }
      const person = await resolvePerson(data.uid, data.role);
      if (!person.phone) { await done("No phone number on this account yet"); return; }
      const assist = await import("../agents/adminAssist");
      switch (data.type) {
        case "request_consent":
          await assist.requestAdminAssist({ uid: data.uid, role: data.role, phone: person.phone, firstName: person.firstName, adminUid: data.adminUid, adminName: data.adminName ?? "" });
          break;
        case "end_consent":
          await assist.endAdminAssist({ uid: data.uid, phone: person.phone, adminUid: data.adminUid, adminName: data.adminName ?? "", reason: "ended" });
          break;
        case "acted": {
          // Only inside an open window (the rules already gate the write itself; this gates the record + text).
          if (!(await assist.assistWindowOpenFor(data.uid, data.adminUid))) { await done("No open consent window for this person"); return; }
          const kind = String(data.kind ?? "").trim() || "change";
          const summary = String(data.summary ?? "").trim() || "made a change on your account";
          await assist.recordAdminActed({
            uid: data.uid, role: data.role, adminUid: data.adminUid, adminName: data.adminName ?? "", kind, summary,
            sourcePath: snap.ref.path, eventId: snap.id, phone: person.phone, ...(data.extra ? { extra: data.extra } : {}),
          });
          break;
        }
        case "send_link": {
          const kind = String(data.linkKind ?? "");
          if (!linkKindAllowedForRole(kind, data.role)) { await done(`That link isn't one for a ${data.role === "client" ? "client" : "care provider"}`); return; }
          const { sendOnboardingLink } = await import("../agents/onboardingConversation");
          try {
            await sendOnboardingLink(person.phone, kind);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // No text session yet = the person has never texted Evia / verified a phone with her.
            await done(/no session|no chatId/i.test(msg) ? "This person hasn't texted Evia yet, so there's no thread to send the link to" : msg);
            return;
          }
          await logAudit({ eventType: "admin_link_sent", userId: data.uid, phone: person.phone, data: { linkKind: kind, adminUid: data.adminUid, adminName: data.adminName ?? "" } });
          break;
        }
        default:
          await done(`Unknown type: ${String(data.type)}`);
          return;
      }
      await done(null);
    } catch (err) {
      await done(err instanceof Error ? err.message : String(err));
    }
  });
