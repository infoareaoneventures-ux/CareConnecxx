// Cancel — backend port of every cancel button on the website's My Bookings
// page (components/client/ClientVisitsPage.tsx): the per-visit ✕
// (handleCancelShift), Skip on a Needs Replacement visit (handleSkipReplacement,
// same write), Cancel Booking (handleCancelBooking), Cancel Request on a
// pending booking request (handleCancelPendingBooking), Cancel Request on a
// pending schedule change (booking_amendments), and the replacement request's
// Cancel (handleWithdrawReplacement). One implementation shared by the MCP
// tool (manage_booking) and the scripted cancelFlow.ts, so the tool path and
// the conversation path can never drift apart in what they write.
//
// 2026-09-17: replaces the legacy CANCEL_REQUEST path, which queried the
// retired `appointments` collection and parked a `pendingCancelConfirm` flag
// that a YES/NO router branch turned into an appointments write nothing on
// the site ever read.
import * as admin from "firebase-admin";
import { businessTodayStr, formatDateWithWeekday, formatHHMMForDisplay } from "../utils/scheduledTime";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();
const FV = admin.firestore.FieldValue;

export type CancelKind = "visit" | "booking" | "pending_request" | "replacement_request" | "amendment";

export interface CancelOption {
  kind: CancelKind;
  id: string;
  caregiverName: string;
  // One line, the way the site's card reads.
  label: string;
  // The site's own confirm-dialog wording for this button.
  confirmText: string;
  // Sort key (soonest first for visits; requests after).
  sortKey: string;
}

function visitWindow(s: FirebaseFirestore.DocumentData): string {
  const start = formatHHMMForDisplay(String(s.startTime ?? ""));
  const end = s.endTime ? `–${formatHHMMForDisplay(String(s.endTime))}` : "";
  return `${formatDateWithWeekday(String(s.date ?? ""))}, ${start}${end}`;
}

function describeSchedule(schedule: Record<string, unknown> | undefined): string {
  const dst = (schedule?.dayShiftTimes ?? {}) as Record<string, Array<{ start?: string; end?: string }> | { start?: string; end?: string }>;
  const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const parts = Object.entries(dst)
    .map(([day, v]) => {
      const blocks = (Array.isArray(v) ? v : [v]).filter((b) => b?.start && b?.end);
      return blocks.length ? { day, text: `${day} ${blocks.map((b) => `${formatHHMMForDisplay(String(b.start))}–${formatHHMMForDisplay(String(b.end))}`).join(" & ")}` } : null;
    })
    .filter((x): x is { day: string; text: string } => !!x)
    .sort((a, b) => order.indexOf(a.day.slice(0, 3)) - order.indexOf(b.day.slice(0, 3)));
  return parts.map((p) => p.text).join(", ");
}

// Everything the family could press Cancel on right now, read fresh — the
// My Bookings page's Active Bookings visits + Cancel Booking buttons, and the
// Requests tab's Cancel Request buttons.
export async function listCancellables(clientId: string): Promise<CancelOption[]> {
  const today = businessTodayStr();
  const [shiftSnap, brSnap, amSnap] = await Promise.all([
    db.collection("shifts")
      .where("clientId", "==", clientId)
      .where("status", "in", ["scheduled", "in-progress", "needs_replacement"])
      .where("date", ">=", today)
      .orderBy("date", "asc")
      .limit(30)
      .get(),
    db.collection("booking_requests").where("clientId", "==", clientId).get(),
    db.collection("booking_amendments").where("clientId", "==", clientId).where("status", "==", "pending").get(),
  ]);

  const out: CancelOption[] = [];
  const scheduledByBooking = new Map<string, FirebaseFirestore.DocumentData[]>();

  // Per-visit ✕ appears on 'scheduled' (incl. overdue) — and Skip on
  // 'needs_replacement' — never on an in-progress visit.
  for (const d of shiftSnap.docs) {
    const s = d.data();
    if (s.bookingRequestId) {
      const list = scheduledByBooking.get(String(s.bookingRequestId)) ?? [];
      list.push(s);
      scheduledByBooking.set(String(s.bookingRequestId), list);
    }
    if (s.status !== "scheduled" && s.status !== "needs_replacement") continue;
    // A needs-replacement visit with a replacement request already out shows
    // "Choose someone else" on the page (withdraw that request — listed
    // below as its own option), not Skip.
    if (s.status === "needs_replacement" && s.replacementRequestId) continue;
    const cg = String(s.caregiverName ?? "your caregiver");
    out.push({
      kind: "visit", id: d.id, caregiverName: cg,
      label: `${s.status === "needs_replacement" ? "Needs-replacement visit" : "Visit"} — ${visitWindow(s)} with ${cg}`,
      confirmText: s.status === "needs_replacement"
        ? `Skip the ${visitWindow(s)} visit? No replacement caregiver will be arranged and it will be marked cancelled.`
        : `Cancel only the ${visitWindow(s)} visit with ${cg}? The rest of the booking stays active.`,
      sortKey: `0_${s.date}_${s.startTime}`,
    });
  }

  for (const d of brSnap.docs) {
    const b = d.data();
    const cg = String(b.caregiverName ?? "the caregiver");
    if (b.status === "accepted" && (scheduledByBooking.get(d.id) ?? []).some((s) => s.status === "scheduled" || s.status === "needs_replacement")) {
      const remaining = (scheduledByBooking.get(d.id) ?? []).filter((s) => s.status === "scheduled" || s.status === "needs_replacement").length;
      const sched = describeSchedule(b.schedule as Record<string, unknown> | undefined);
      out.push({
        kind: "booking", id: d.id, caregiverName: cg,
        label: `Whole booking with ${cg}${sched ? ` (${sched})` : ""} — ${remaining} upcoming visit${remaining === 1 ? "" : "s"}`,
        confirmText: `Cancel the whole booking with ${cg} and all ${remaining} upcoming visit${remaining === 1 ? "" : "s"}?`,
        sortKey: `1_${cg}`,
      });
    } else if (b.status === "pending") {
      if (b.isShiftReplacement) {
        out.push({
          kind: "replacement_request", id: d.id, caregiverName: cg,
          label: `Replacement request to ${cg} (awaiting response)`,
          confirmText: `Cancel the replacement request to ${cg}? The visit stays as Needs Replacement so you can choose someone else.`,
          sortKey: `2_${cg}`,
        });
      } else {
        const sched = describeSchedule(b.schedule as Record<string, unknown> | undefined);
        out.push({
          kind: "pending_request", id: d.id, caregiverName: cg,
          label: `Booking request to ${cg}${sched ? ` (${sched})` : ""} — awaiting their response`,
          confirmText: `Cancel the booking request to ${cg}? They'll be told you withdrew it.`,
          sortKey: `2_${cg}`,
        });
      }
    }
  }

  for (const d of amSnap.docs) {
    const a = d.data();
    const cg = String(a.caregiverName ?? "the caregiver");
    const days = describeSchedule({ dayShiftTimes: a.newDays });
    out.push({
      kind: "amendment", id: d.id, caregiverName: cg,
      label: `Schedule-change request to ${cg}${days ? ` (${days})` : ""} — awaiting their response`,
      confirmText: `Cancel the schedule-change request to ${cg}?`,
      sortKey: `3_${cg}`,
    });
  }

  return out.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

export type CancelResult =
  | { ok: true; kind: CancelKind; id: string; detail: string }
  | { ok: false; code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT"; message: string };

// handleCancelShift / handleSkipReplacement: one visit, in place. Clears any
// pending reschedule proposal (a cancelled visit has nothing left to move).
export async function cancelVisit(clientId: string, shiftId: string, source: string): Promise<CancelResult> {
  const ref = db.collection("shifts").doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: "NOT_FOUND", message: "Visit not found" };
  const shift = snap.data()!;
  if (shift.clientId !== clientId) return { ok: false, code: "PERMISSION_DENIED", message: "Visit does not belong to this client" };
  // shifts.status → cancelled fires onShiftStatusChanged (notificationTriggers.ts),
  // which notifies the caregiver — no manual send here. Two page buttons, two
  // exact writes:
  if (shift.status === "scheduled") {
    // ✕ on a scheduled row — handleCancelShift (clears any pending proposal).
    await ref.update({
      status: "cancelled",
      cancelledBy: "client",
      reschedulePendingDate: FV.delete(),
      reschedulePendingStartTime: FV.delete(),
      reschedulePendingEndTime: FV.delete(),
      rescheduledBy: FV.delete(),
    });
  } else if (shift.status === "needs_replacement") {
    if (shift.replacementRequestId) {
      return {
        ok: false, code: "INVALID_INPUT",
        message: `A replacement request to ${String(shift.replacementCaregiverName ?? "another caregiver")} is still out for this visit — withdraw that request ("Choose someone else") instead of skipping`,
      };
    }
    // Skip on a needs-replacement row — handleSkipReplacement.
    await ref.update({ status: "cancelled", cancelledBy: "client", updatedAt: FV.serverTimestamp() });
  } else {
    return { ok: false, code: "INVALID_INPUT", message: `Only a scheduled or needs-replacement visit can be cancelled this way (status: ${shift.status})` };
  }
  logAudit({ eventType: "shift_cancelled", userId: clientId, data: { source, shiftId } }).catch(() => {});
  return { ok: true, kind: "visit", id: shiftId, detail: visitWindow(shift) };
}

// handleCancelBooking: every still-scheduled (or needs-replacement) visit
// under the booking, flagged bulkCancelled so the per-visit trigger skips its
// individual notice, then the booking itself → onBookingRequestWrite tells the
// caregiver once.
export async function cancelWholeBooking(clientId: string, bookingRequestId: string, source: string): Promise<CancelResult & { shiftsCancelled?: number }> {
  const brRef = db.collection("booking_requests").doc(bookingRequestId);
  const brSnap = await brRef.get();
  if (!brSnap.exists) return { ok: false, code: "NOT_FOUND", message: "Booking not found" };
  const br = brSnap.data()!;
  if (br.clientId !== clientId) return { ok: false, code: "PERMISSION_DENIED", message: "Booking does not belong to this client" };
  if (br.status === "cancelled") return { ok: true, kind: "booking", id: bookingRequestId, detail: String(br.caregiverName ?? ""), shiftsCancelled: 0 };
  const shiftsSnap = await db.collection("shifts")
    .where("bookingRequestId", "==", bookingRequestId)
    .where("status", "in", ["scheduled", "needs_replacement"])
    .where("clientId", "==", clientId)
    .get();
  const batch = db.batch();
  shiftsSnap.docs.forEach((d) => batch.update(d.ref, { status: "cancelled", bulkCancelled: true }));
  await batch.commit();
  await brRef.update({ status: "cancelled" });
  logAudit({ eventType: "booking_cancelled", userId: clientId, data: { source, bookingRequestId, shiftsCancelled: shiftsSnap.size } }).catch(() => {});
  return { ok: true, kind: "booking", id: bookingRequestId, detail: String(br.caregiverName ?? "the caregiver"), shiftsCancelled: shiftsSnap.size };
}

// handleCancelPendingBooking: withdraw a request the caregiver hasn't answered.
export async function cancelPendingRequest(clientId: string, bookingRequestId: string, source: string): Promise<CancelResult> {
  const brRef = db.collection("booking_requests").doc(bookingRequestId);
  const brSnap = await brRef.get();
  if (!brSnap.exists) return { ok: false, code: "NOT_FOUND", message: "Booking request not found" };
  const br = brSnap.data()!;
  if (br.clientId !== clientId) return { ok: false, code: "PERMISSION_DENIED", message: "Booking request does not belong to this client" };
  if (br.status !== "pending") return { ok: false, code: "INVALID_INPUT", message: `Only a pending request can be cancelled this way (status: ${br.status})` };
  await brRef.update({ status: "cancelled" });
  logAudit({ eventType: "booking_request_cancelled", userId: clientId, data: { source, bookingRequestId } }).catch(() => {});
  return { ok: true, kind: br.isShiftReplacement ? "replacement_request" : "pending_request", id: bookingRequestId, detail: String(br.caregiverName ?? "the caregiver") };
}

// handleWithdrawReplacement: the replacement request only — the visit stays
// 'needs_replacement' so a different candidate can be chosen.
export async function withdrawReplacementRequest(clientId: string, bookingRequestId: string, source: string): Promise<CancelResult> {
  const brRef = db.collection("booking_requests").doc(bookingRequestId);
  const brSnap = await brRef.get();
  if (!brSnap.exists) return { ok: false, code: "NOT_FOUND", message: "Replacement request not found" };
  const br = brSnap.data()!;
  if (br.clientId !== clientId) return { ok: false, code: "PERMISSION_DENIED", message: "Replacement request does not belong to this client" };
  if (!br.isShiftReplacement) return { ok: false, code: "INVALID_INPUT", message: "This booking request isn't a replacement request" };
  await brRef.update({ status: "cancelled", updatedAt: FV.serverTimestamp() });
  logAudit({ eventType: "callout_backup_withdrawn", userId: clientId, data: { source, bookingRequestId } }).catch(() => {});
  return { ok: true, kind: "replacement_request", id: bookingRequestId, detail: String(br.caregiverName ?? "the caregiver") };
}

// The Requests tab's Cancel Request on a schedule-change card.
export async function cancelPendingAmendment(clientId: string, amendmentId: string, source: string): Promise<CancelResult> {
  const amRef = db.collection("booking_amendments").doc(amendmentId);
  const amSnap = await amRef.get();
  if (!amSnap.exists) return { ok: false, code: "NOT_FOUND", message: "Amendment request not found" };
  const am = amSnap.data()!;
  if (am.clientId !== clientId) return { ok: false, code: "PERMISSION_DENIED", message: "Amendment does not belong to this client" };
  if (am.status !== "pending") return { ok: false, code: "INVALID_INPUT", message: `Only a pending amendment can be cancelled (status: ${am.status})` };
  await amRef.update({ status: "cancelled" });
  logAudit({ eventType: "amendment_cancelled", userId: clientId, data: { source, amendmentId } }).catch(() => {});
  return { ok: true, kind: "amendment", id: amendmentId, detail: String(am.caregiverName ?? "the caregiver") };
}

export async function applyCancel(clientId: string, opt: { kind: CancelKind; id: string }, source: string): Promise<CancelResult> {
  switch (opt.kind) {
    case "visit":               return cancelVisit(clientId, opt.id, source);
    case "booking":             return cancelWholeBooking(clientId, opt.id, source);
    case "pending_request":     return cancelPendingRequest(clientId, opt.id, source);
    case "replacement_request": return withdrawReplacementRequest(clientId, opt.id, source);
    case "amendment":           return cancelPendingAmendment(clientId, opt.id, source);
  }
}
