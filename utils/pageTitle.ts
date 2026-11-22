// The browser-tab title for a route ("Calendar · Evia"), so several open tabs can be told apart.
// The home page keeps the title in index.html (it is the one that search engines read).
export const DEFAULT_PAGE_TITLE = "Evia";

const TITLES: Array<[prefix: string, title: string]> = [
  ["/client/dashboard", "Dashboard"],
  ["/client/account", "Account settings"],
  ["/client/payments", "Payments"],
  ["/client/my-care-team", "My care team"],
  ["/client/find-care-providers", "Find care"],
  ["/client/post-job", "Post a job"],
  ["/client/posts", "Care requests"],
  ["/client/membership", "Membership"],
  ["/client/calendar", "Calendar"],
  ["/client/bookings", "My bookings"],
  ["/client/care-provider/", "Care provider"],
  ["/client/care-plan", "Care plan"],
  ["/client/inbox", "Inbox"],
  ["/client/connect", "Connect"],
  ["/care-provider/dashboard", "Dashboard"],
  ["/care-provider/profile", "My profile"],
  ["/care-provider/inbox", "Inbox"],
  ["/care-provider/calendar", "Calendar"],
  ["/care-provider/bookings", "Bookings"],
  ["/care-provider/jobs", "Jobs"],
  ["/care-provider/families", "Families"],
  ["/care-provider/settings", "Settings"],
  ["/care-provider/payments", "Payments"],
  ["/care-provider/connect", "Connect"],
  ["/care-provider/", "Care provider"],
  ["/p/", "Care provider"],
  ["/admin/audit", "Audit"],
  ["/admin", "Admin"],
  ["/login", "Log in"],
  ["/start", "Get started"],
  ["/terms", "Terms of Service"],
  ["/privacy", "Privacy Policy"],
  ["/payment/success", "Payment received"],
  ["/payment/cancel", "Payment cancelled"],
];

/** The tab title for a path, or null to leave the page's own title (the home page). */
export function pageTitleFor(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return null;
  for (const [prefix, title] of TITLES) {
    if (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)) return `${title} · Evia`;
  }
  return DEFAULT_PAGE_TITLE;
}
