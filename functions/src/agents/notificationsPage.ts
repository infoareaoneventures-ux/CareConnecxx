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
    if (t === "review_prompt") return data.caregiverId ? `/client/care-provider/${data.caregiverId}?review=1` : "/client/dashboard";
    if (t.startsWith("account")) return "/client/account";
    if (t === "job_application") return "/client/posts";
    if (t.startsWith("interview") || t === "hire_decision") return "/client/posts?tab=interviews";
    // Timesheets (submitted / approved / counter / auto-accepted / payment failed) live on Payments.
    if (t.startsWith("shift_hours")) return "/client/payments";
    if (t === "booking_declined" || tt === "booking_declined") return "/client/find-care-providers";
    if (t === "shift_completed") return "/client/bookings?tab=past";
    if (t === "amendment_request") return "/client/bookings?tab=requests";
    if (t.startsWith("booking") || t.startsWith("amendment") || t.startsWith("shift")) return "/client/bookings?tab=active";
    if (t === "alert" && (tt.startsWith("shift") || data.appointmentId || data.recurringGroupId)) return "/client/bookings?tab=active";
    if (t.includes("membership")) return "/client/membership";
    if (t.includes("payment")) return "/client/payments";
    return "/client/dashboard";
  }
  // ── Caregiver: the page the bell's body names (caregiver sweep C10, 2026-10-11) ──
  // Before this, new_job / application outcomes landed on the dashboard, membership
  // on Payments, bgcheck / MVR / renewal on the dashboard, and every shift, booking
  // and amendment on the Requests tab (the Bookings page's default).
  return caregiverRoute(t, tt, data);
}

// Mirror of utils/notificationRoutes.ts caregiverRoute — keep in lockstep (the
// parity test compiles the site file and runs both over every known type).
function caregiverRoute(t: string, tt: string, data: Record<string, unknown>): string {
  const shiftId = typeof data.shiftId === "string" && data.shiftId ? data.shiftId : "";
  const active = shiftId ? `/care-provider/bookings?tab=active&visit=${shiftId}` : "/care-provider/bookings?tab=active";

  // Jobs page — the job card itself, My Applications, Interviews.
  if (t === "new_job") return typeof data.jobId === "string" && data.jobId ? `/care-provider/jobs?job=${data.jobId}` : "/care-provider/jobs";
  if (t.startsWith("job_application")) return "/care-provider/jobs?tab=applications";
  if (t.startsWith("interview") || t === "hire_decision") return "/care-provider/jobs?tab=interviews";

  // Payments — Timesheets events (submitted / approved / correction / paid / reminders) and payouts.
  if (t.startsWith("shift_hours")) return "/care-provider/payments?tab=timesheets";
  if (t.includes("payout")) return "/care-provider/payments?tab=payouts";

  // Bookings — a request waiting on the caregiver (or withdrawn) → Requests; a finished or
  // unfinished-past visit → Past (Log Hours lives there); every live-visit event → Active.
  if (t.startsWith("booking") || t.startsWith("amendment")) return "/care-provider/bookings?tab=requests";
  if (t === "shift_completed" || t === "shift_missed") return "/care-provider/bookings?tab=past";
  if (t.startsWith("shift")) return active;
  if (t === "alert" && (tt.startsWith("shift") || data.appointmentId || data.recurringGroupId)) return active;

  // Settings › Membership & verification — membership, background check, driving record,
  // renewal refresh, Transportation live/removed, account standing (the cards moved there 2026-10-04).
  if (t.includes("membership") || t.includes("bgcheck") || t.includes("mvr") || t.includes("renewal") || t.includes("transport_badge") || t.startsWith("account")) return "/care-provider/settings";
  // "You're all set — families can now find and book you" → the Jobs page.
  if (t === "caregiver_now_bookable") return "/care-provider/jobs";
  // A new review lives on the caregiver's own profile page (Reviews card) — it used to fall through to the dashboard (2026-10-07).
  if (t === "review_received") return "/care-provider/profile?section=reviews";
  // onboarding_reminder ("pick up on your dashboard") and anything unknown → the dashboard.
  return "/care-provider/dashboard";
}

/** The page's name as the nav shows it, for the text. */
export function pageLabelFor(path: string): string {
  const base = path.split("?")[0];
  const qs = new URLSearchParams(path.split("?")[1] ?? "");
  const tab = qs.get("tab");
  const section = qs.get("section");
  if (base.startsWith("/client/care-provider/")) return path.includes("review=1") ? "the care provider's profile (Leave a Review)" : "the care provider's profile";
  const labels: Record<string, string> = {
    "/client/posts": tab === "interviews" ? "Care Requests › Interviews" : "Care Requests › Posts",
    "/client/bookings": tab === "past" ? "My Bookings › Past Bookings" : tab === "requests" ? "My Bookings › Requests" : "My Bookings › Active Bookings",
    "/client/find-care-providers": "Find Care Providers",
    "/client/membership": "Membership",
    "/client/payments": "Payments",
    "/client/dashboard": "Dashboard",
    "/client/account": "Account Settings",
    "/care-provider/settings": "Account Settings",
    "/care-provider/jobs": tab === "interviews" ? "Jobs › Interviews" : tab === "applications" ? "Jobs › My Applications" : "Jobs",
    "/care-provider/bookings": tab === "requests" ? "My Bookings › Requests" : tab === "past" ? "My Bookings › Past Bookings" : tab === "active" ? "My Bookings › Active Bookings" : "My Bookings",
    "/care-provider/payments": tab === "timesheets" ? "Payments › Timesheets" : tab === "payouts" ? "Payments › Payouts" : "Payments",
    "/care-provider/profile": section === "reviews" ? "My Profile › Reviews" : "My Profile",
    "/care-provider/dashboard": "Dashboard",
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
