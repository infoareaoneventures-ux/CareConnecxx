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
  [{ type: "review_prompt", data: { caregiverId: "cg1" } }, "/client/caregiver/cg1?review=1"],
  [{ type: "job_application" }, "/client/posts"],
  [{ type: "interview_accepted" }, "/client/posts?tab=interviews"],
  [{ type: "interview_declined" }, "/client/posts?tab=interviews"],
  [{ type: "interview_rescheduled" }, "/client/posts?tab=interviews"],
  [{ type: "interview_cancelled" }, "/client/posts?tab=interviews"],
  [{ type: "booking_declined" }, "/client/find-caregivers"],
  [{ type: "alert", transitionType: "booking_declined", data: { appointmentId: "a1" } }, "/client/find-caregivers"],
  [{ type: "alert", transitionType: "shift_cancelled_by_caregiver", data: { appointmentId: "a1" } }, "/client/bookings?tab=active"],
  [{ type: "booking", transitionType: "booking_confirmed" }, "/client/bookings?tab=active"],
  [{ type: "booking_accepted" }, "/client/bookings?tab=active"],
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
  it("caregiver routes are unchanged", () => {
    expect(routeForNotification({ type: "booking_request" }, "caregiver")).toBe("/caregiver/bookings");
    expect(routeForNotification({ type: "interview_request" }, "caregiver")).toBe("/caregiver/jobs?tab=interviews");
    expect(routeForNotification({ type: "review_received" }, "caregiver")).toBe("/caregiver/dashboard");
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
    for (const t of ["booking_request", "interview_request", "amendment_request", "review_received", "payout_paid", "membership_payment_failed"]) {
      expect(site({ type: t }, "caregiver")).toBe(routeForNotification({ type: t }, "caregiver"));
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
    expect(pageLabelFor("/client/caregiver/cg1?review=1")).toBe("the caregiver's profile (Leave a Review)");
    expect(pageLabelFor("/client/posts?tab=interviews")).toBe("Care Requests › Interviews");
    expect(pageLabelFor("/client/find-caregivers")).toBe("Find Caregivers");
  });
});
