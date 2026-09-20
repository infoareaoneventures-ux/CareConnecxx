// The website's bell (components/ui/NotificationDropdown.tsx +
// hooks/useNotifications.ts) as data, for Evia: the same query (the family's
// last 50 notifications, newest first, minus chat messages and deleted ones),
// the same unread count, the same three actions (mark one read, mark all read,
// delete one — the bell's swipe/trash), and for each notification the page the
// bell would open — the mirror of utils/notificationRoutes.ts, path for path
// (notificationsPage.test.ts compiles the site file and asserts parity).
// Built 2026-09-19 (founder: "does each notification land me on the right
// page … Evia to the notification").
import * as admin from "firebase-admin";

export type NotificationRole = "client" | "caregiver";

export interface RoutableNotification {
  type?: string;
  transitionType?: string;
  data?: Record<string, unknown> | null;
}

/** Mirror of utils/notificationRoutes.ts routeForNotification — keep in lockstep. */
export function routeForNotification(n: RoutableNotification, role: NotificationRole): string {
  const t = String(n.type || "");
  const tt = String(n.transitionType || "");
  const data = (n.data || {}) as Record<string, unknown>;
  if (role === "client") {
    if (t === "review_prompt") return data.caregiverId ? `/client/caregiver/${data.caregiverId}?review=1` : "/client/dashboard";
    if (t === "job_application") return "/client/posts";
    if (t.startsWith("interview") || t === "hire_decision") return "/client/posts?tab=interviews";
    // Timesheets (submitted / approved / counter / auto-accepted / payment failed) live on Payments.
    if (t.startsWith("shift_hours")) return "/client/payments";
    if (t === "booking_declined" || tt === "booking_declined") return "/client/find-caregivers";
    if (t === "shift_completed") return "/client/bookings?tab=past";
    if (t === "amendment_request") return "/client/bookings?tab=requests";
    if (t.startsWith("booking") || t.startsWith("amendment") || t.startsWith("shift")) return "/client/bookings?tab=active";
    if (t === "alert" && (tt.startsWith("shift") || data.appointmentId || data.recurringGroupId)) return "/client/bookings?tab=active";
    if (t.includes("membership")) return "/client/membership";
    if (t.includes("payment")) return "/client/payments";
    return "/client/dashboard";
  }
  if (t.startsWith("interview") || t === "hire_decision") return "/caregiver/jobs?tab=interviews";
  if (t.startsWith("booking") || t.startsWith("amendment") || t.startsWith("shift")) return "/caregiver/bookings";
  if (t.includes("payment") || t.includes("payout") || t.includes("membership")) return "/caregiver/payments";
  return "/caregiver/dashboard";
}

/** The page's name as the nav shows it, for the text. */
export function pageLabelFor(path: string): string {
  const base = path.split("?")[0];
  const tab = new URLSearchParams(path.split("?")[1] ?? "").get("tab");
  if (base.startsWith("/client/caregiver/")) return path.includes("review=1") ? "the caregiver's profile (Leave a Review)" : "the caregiver's profile";
  const labels: Record<string, string> = {
    "/client/posts": tab === "interviews" ? "Care Requests › Interviews" : "Care Requests › Posts",
    "/client/bookings": tab === "past" ? "My Bookings › Past Bookings" : tab === "requests" ? "My Bookings › Requests" : "My Bookings › Active Bookings",
    "/client/find-caregivers": "Find Caregivers",
    "/client/membership": "Membership",
    "/client/payments": "Payments",
    "/client/dashboard": "Dashboard",
    "/caregiver/jobs": "Jobs › Interviews",
    "/caregiver/bookings": "My Bookings",
    "/caregiver/payments": "Payments",
    "/caregiver/dashboard": "Dashboard",
  };
  return labels[base] ?? base;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  /** ISO time, or null when the record has no usable timestamp. */
  at: string | null;
  /** Where the bell takes you: the site path and the page's name. */
  page: { path: string; label: string };
}

export interface NotificationsPage {
  total: number;
  unreadCount: number;
  items: NotificationItem[];
  summary: string;
}

const toIso = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === "string") { const ms = Date.parse(v); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
  const d = v as { toDate?: () => Date; seconds?: number };
  if (typeof d.toDate === "function") return d.toDate().toISOString();
  if (typeof d.seconds === "number") return new Date(d.seconds * 1000).toISOString();
  return null;
};

/** The hook's normalization + filter + sort, on raw docs. */
export function shapeNotificationsPage(
  docs: Array<{ id: string; data: Record<string, unknown> }>,
  role: NotificationRole,
  opts: { show?: number } = {},
): NotificationsPage {
  const items = docs
    .map((d) => ({ id: d.id, ...d.data } as Record<string, unknown> & { id: string }))
    // The bell hides chat messages (the Inbox owns them) and swiped-away ones.
    .filter((n) => n.type !== "message" && n.isDeleted !== true)
    .sort((a, b) => (Date.parse(toIso(b.createdAt) ?? "") || 0) - (Date.parse(toIso(a.createdAt) ?? "") || 0))
    .map<NotificationItem>((n) => {
      const path = routeForNotification({ type: String(n.type ?? ""), transitionType: typeof n.transitionType === "string" ? n.transitionType : undefined, data: (n.data as Record<string, unknown>) ?? null }, role);
      return {
        id: n.id,
        type: String(n.type ?? ""),
        title: String(n.title ?? ""),
        body: String(n.body ?? n.message ?? ""),
        isRead: (n.isRead ?? n.read ?? false) === true,
        at: toIso(n.createdAt),
        page: { path, label: pageLabelFor(path) },
      };
    });
  const unreadCount = items.filter((n) => !n.isRead).length;
  const show = Math.max(1, opts.show ?? 5);
  const lines = items.slice(0, show).map((n) => `${n.isRead ? "" : "• "}${n.title}${n.body ? ` — ${n.body}` : ""} (${n.page.label})`);
  const summary = items.length
    ? `${unreadCount} unread of ${items.length}. ${lines.join(" | ")}${items.length > show ? ` … and ${items.length - show} more.` : ""}`
    : "No notifications.";
  return { total: items.length, unreadCount, items, summary };
}

/** The hook's query: the user's notifications, newest first, 50 at most. */
export async function readNotificationsPage(userId: string, role: NotificationRole, opts: { show?: number } = {}): Promise<NotificationsPage> {
  const db = admin.firestore();
  const snap = await db.collection("users").doc(userId).collection("notifications").orderBy("createdAt", "desc").limit(50).get();
  return shapeNotificationsPage(snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })), role, opts);
}

/** The bell's "Mark all read" (batch) or a click on one (single) — isRead + readAt, as the hook writes. */
export async function markNotificationsRead(userId: string, notificationId?: string): Promise<number> {
  const db = admin.firestore();
  const coll = db.collection("users").doc(userId).collection("notifications");
  const stamp = { isRead: true, readAt: admin.firestore.FieldValue.serverTimestamp() };
  if (notificationId) { await coll.doc(notificationId).update(stamp); return 1; }
  const snap = await coll.orderBy("createdAt", "desc").limit(50).get();
  const unread = snap.docs.filter((d) => { const n = d.data(); return (n.isRead ?? n.read ?? false) !== true && n.isDeleted !== true && n.type !== "message"; });
  if (!unread.length) return 0;
  const batch = db.batch();
  for (const d of unread) batch.update(d.ref, stamp);
  await batch.commit();
  return unread.length;
}

/** The bell's trash icon — a soft delete, exactly the hook's write. */
export async function deleteNotification(userId: string, notificationId: string): Promise<void> {
  await admin.firestore().collection("users").doc(userId).collection("notifications").doc(notificationId)
    .update({ isDeleted: true, deletedAt: admin.firestore.FieldValue.serverTimestamp() });
}
