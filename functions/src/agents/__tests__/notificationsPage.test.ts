// The bell as data: same filter, same unread count, same destination per type
// as the site — and the route map is proven identical to utils/notificationRoutes.ts
// by compiling the site file and running both over every known type.
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

vi.mock("firebase-admin", () => ({ firestore: Object.assign(() => ({ collection: () => ({}) }), { FieldValue: { serverTimestamp: () => "__ts__" } }) }));

import { routeForNotification, pageLabelFor, shapeNotificationsPage } from "../notificationsPage";

const CLIENT_CASES: Array<[Record<string, unknown>, string]> = [
  [{ type: "review_prompt", data: { caregiverId: "cg1" } }, "/client/care-provider/cg1?review=1"],
  [{ type: "job_application" }, "/client/posts"],
  [{ type: "interview_accepted" }, "/client/posts?tab=interviews"],
  [{ type: "interview_declined" }, "/client/posts?tab=interviews"],
  [{ type: "interview_rescheduled" }, "/client/posts?tab=interviews"],
  [{ type: "interview_cancelled" }, "/client/posts?tab=interviews"],
  [{ type: "booking_declined" }, "/client/find-care-providers"],
  [{ type: "alert", transitionType: "booking_declined", data: { appointmentId: "a1" } }, "/client/find-care-providers"],
  [{ type: "alert", transitionType: "shift_cancelled_by_caregiver", data: { appointmentId: "a1" } }, "/client/bookings?tab=active"],
  [{ type: "booking", transitionType: "booking_confirmed" }, "/client/bookings?tab=active"],
  [{ type: "booking_accepted" }, "/client/bookings?tab=active"],
  [{ type: "booking_request_expired", data: { bookingId: "rep1", shiftId: "s9" } }, "/client/bookings?tab=active"], // B6: the visit's Find replacement button is back
  [{ type: "shift_hours_payment_failed" }, "/client/payments"],
  [{ type: "shift_hours_approved" }, "/client/payments"],
  [{ type: "shift_hours_counter_proposed" }, "/client/payments"],
  [{ type: "shift_started" }, "/client/bookings?tab=active"],
  [{ type: "shift_completed" }, "/client/bookings?tab=past"],
  [{ type: "shift_rescheduled" }, "/client/bookings?tab=active"],
  [{ type: "shift_needs_replacement" }, "/client/bookings?tab=active"],
  [{ type: "shift_cancelled" }, "/client/bookings?tab=active"],
  [{ type: "amendment_accepted" }, "/client/bookings?tab=active"],
  [{ type: "amendment_declined" }, "/client/bookings?tab=active"],
  [{ type: "amendment_request" }, "/client/bookings?tab=requests"],
  [{ type: "membership_payment_failed" }, "/client/membership"],
  [{ type: "membership_payment_succeeded" }, "/client/membership"],
  [{ type: "membership_cancelled" }, "/client/membership"],
  [{ type: "payment_received" }, "/client/payments"],
  [{ type: "alert" }, "/client/dashboard"],
  [{ type: "system" }, "/client/dashboard"],
];

describe("routeForNotification — every family type lands on the page that shows it", () => {
  it.each(CLIENT_CASES)("%j → %s", (n, expected) => {
    expect(routeForNotification(n as any, "client")).toBe(expected);
  });
});

// Caregiver sweep C10 (2026-10-11): every caregiver bell lands on the page its body names.
const CAREGIVER_CASES: Array<[Record<string, unknown>, string]> = [
  [{ type: "new_job", data: { jobId: "j1" } }, "/care-provider/jobs?job=j1"],
  [{ type: "new_job" }, "/care-provider/jobs"],
  [{ type: "job_application_accepted" }, "/care-provider/jobs?tab=applications"],
  [{ type: "job_application_declined" }, "/care-provider/jobs?tab=applications"],
  [{ type: "interview_request" }, "/care-provider/jobs?tab=interviews"],
  [{ type: "interview_confirmed" }, "/care-provider/jobs?tab=interviews"],
  [{ type: "interview_reminder" }, "/care-provider/jobs?tab=interviews"],
  [{ type: "hire_decision" }, "/care-provider/jobs?tab=interviews"],
  [{ type: "shift_hours_approved" }, "/care-provider/payments?tab=timesheets"],
  [{ type: "shift_hours_paid" }, "/care-provider/payments?tab=timesheets"],
  [{ type: "shift_hours_unsubmitted" }, "/care-provider/payments?tab=timesheets"],
  [{ type: "payout_paid" }, "/care-provider/payments?tab=payouts"],
  [{ type: "payout_initiated" }, "/care-provider/payments?tab=payouts"],
  [{ type: "caregiver_payouts_enabled" }, "/care-provider/payments?tab=payouts"],
  [{ type: "booking_request" }, "/care-provider/bookings?tab=requests"],
  [{ type: "booking_cancelled" }, "/care-provider/bookings?tab=requests"],
  [{ type: "booking_request_expired" }, "/care-provider/bookings?tab=requests"], // B6: an expired replacement request (the Requests tab is where it sat)
  [{ type: "amendment_request" }, "/care-provider/bookings?tab=requests"],
  [{ type: "amendment_cancelled" }, "/care-provider/bookings?tab=requests"],
  [{ type: "shift_cancelled", data: { shiftId: "s1" } }, "/care-provider/bookings?tab=active&visit=s1"],
  [{ type: "shift_rescheduled" }, "/care-provider/bookings?tab=active"],
  [{ type: "shift_starting_soon", data: { shiftId: "s1" } }, "/care-provider/bookings?tab=active&visit=s1"],
  [{ type: "shift_tomorrow", data: { shiftId: "s1" } }, "/care-provider/bookings?tab=active&visit=s1"],
  [{ type: "shift_end_reminder", data: { shiftId: "s1" } }, "/care-provider/bookings?tab=active&visit=s1"],
  [{ type: "shift_missed", data: { shiftId: "s1" } }, "/care-provider/bookings?tab=past"],
  [{ type: "shift_completed" }, "/care-provider/bookings?tab=past"],
  [{ type: "alert", transitionType: "shift_cancelled_by_client", data: { appointmentId: "a1" } }, "/care-provider/bookings?tab=active"],
  [{ type: "caregiver_membership_paid" }, "/care-provider/settings"],
  [{ type: "caregiver_membership_payment_failed" }, "/care-provider/settings"],
  [{ type: "caregiver_membership_renewal_upcoming" }, "/care-provider/settings"],
  [{ type: "membership_payment_failed" }, "/care-provider/settings"],
  [{ type: "caregiver_bgcheck_clear" }, "/care-provider/settings"],
  [{ type: "caregiver_bgcheck_document_required" }, "/care-provider/settings"],
  [{ type: "caregiver_mvr_review" }, "/care-provider/settings"],
  [{ type: "caregiver_renewal_refresh_locked" }, "/care-provider/settings"],
  [{ type: "caregiver_transport_badge_earned" }, "/care-provider/settings"],
  [{ type: "account_email_changed" }, "/care-provider/settings"],
  [{ type: "caregiver_now_bookable" }, "/care-provider/jobs"],
  [{ type: "review_received" }, "/care-provider/profile?section=reviews"],
  [{ type: "onboarding_reminder" }, "/care-provider/dashboard"],
  [{ type: "system" }, "/care-provider/dashboard"],
];

describe("routeForNotification — every caregiver type lands on the page its body names (C10)", () => {
  it.each(CAREGIVER_CASES)("%j → %s", (n, expected) => {
    expect(routeForNotification(n as any, "caregiver")).toBe(expected);
  });
  // Founder 2026-10-12: the site's caregiver routes moved to /care-provider/… —
  // every care-provider bell lands there (the site keeps /caregiver/… as redirects).
  it("every care-provider route lives under /care-provider/", () => {
    for (const [n, expected] of CAREGIVER_CASES) {
      expect(expected.startsWith("/care-provider/"), expected).toBe(true);
      expect(routeForNotification(n as any, "caregiver").startsWith("/care-provider/"), JSON.stringify(n)).toBe(true);
    }
  });
  it("labels name the tab", () => {
    expect(pageLabelFor("/care-provider/jobs?tab=applications")).toBe("Jobs › My Applications");
    expect(pageLabelFor("/care-provider/bookings?tab=requests")).toBe("My Bookings › Requests");
    expect(pageLabelFor("/care-provider/bookings?tab=active&visit=s1")).toBe("My Bookings › Active Bookings");
    expect(pageLabelFor("/care-provider/payments?tab=payouts")).toBe("Payments › Payouts");
  });
});

describe("parity with the site's utils/notificationRoutes.ts", () => {
  it("compiles the site map and gets the same path for every case, both roles", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../../utils/notificationRoutes.ts"), "utf8");
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
    const mod: { exports: Record<string, any> } = { exports: {} };
    new Function("exports", "module", "require", js)(mod.exports, mod, () => ({}));
    const site = mod.exports.routeForNotification as (n: unknown, role: string) => string;
    expect(typeof site).toBe("function");
    for (const [n] of CLIENT_CASES) {
      expect(site(n, "client"), JSON.stringify(n)).toBe(routeForNotification(n as any, "client"));
      expect(site(n, "caregiver"), JSON.stringify(n)).toBe(routeForNotification(n as any, "caregiver"));
    }
    for (const [n] of CAREGIVER_CASES) {
      expect(site(n, "caregiver"), JSON.stringify(n)).toBe(routeForNotification(n as any, "caregiver"));
    }
  });
});

describe("shapeNotificationsPage — the hook's list", () => {
  const docs = [
    { id: "n1", data: { type: "shift_completed", title: "Shift Completed", body: "Basra Yousuf has completed your visit.", isRead: false, createdAt: "2026-09-18T03:38:00.000Z" } },
    { id: "n2", data: { type: "message", title: "New Message", body: "hi", isRead: false, createdAt: "2026-09-18T04:00:00.000Z" } },
    { id: "n3", data: { type: "shift_started", title: "Shift Started", message: "Basra Yousuf has started your visit.", read: true, createdAt: { seconds: Math.floor(Date.parse("2026-09-18T03:03:00.000Z") / 1000) } } },
    { id: "n4", data: { type: "amendment_accepted", title: "Schedule Change Accepted", body: "Basra accepted Thu.", isRead: false, isDeleted: true, createdAt: "2026-09-18T02:00:00.000Z" } },
  ];
  it("drops chat messages and deleted ones, normalizes legacy fields, counts unread, names the page", () => {
    const page = shapeNotificationsPage(docs, "client", { show: 5 });
    expect(page.items.map((i) => i.id)).toEqual(["n1", "n3"]);
    expect(page.unreadCount).toBe(1);
    expect(page.items[1]).toMatchObject({ body: "Basra Yousuf has started your visit.", isRead: true, at: "2026-09-18T03:03:00.000Z", page: { path: "/client/bookings?tab=active", label: "My Bookings › Active Bookings" } });
    expect(page.items[0].page).toEqual({ path: "/client/bookings?tab=past", label: "My Bookings › Past Bookings" });
    expect(page.summary).toBe("1 unread of 2. • Shift Completed — Basra Yousuf has completed your visit. (My Bookings › Past Bookings) | Shift Started — Basra Yousuf has started your visit. (My Bookings › Active Bookings)");
  });
  it("empty → No notifications", () => {
    expect(shapeNotificationsPage([], "client").summary).toBe("No notifications.");
  });
  it("labels", () => {
    expect(pageLabelFor("/client/care-provider/cg1?review=1")).toBe("the care provider's profile (Leave a Review)");
    expect(pageLabelFor("/client/posts?tab=interviews")).toBe("Care Requests › Interviews");
    expect(pageLabelFor("/client/find-care-providers")).toBe("Find Care Providers");
  });
});
