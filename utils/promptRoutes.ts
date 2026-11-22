// Where the "Install Evia" and "Enable notifications" banners may appear. They are asked only
// inside the signed-in app, never on sign-up, consent, upload or payment pages, and never over
// the public site (they covered the dashboard and the background-check consent page).
const BLOCKED_FRAGMENTS = [
  "/signup",
  "/connect",
  "/payment",
  "/membership",
  "/stripe",
  "/bgcheck",
  "/upload",
  "/start",
  "/login",
];

export function promptsAllowedOn(pathname: string): boolean {
  const inApp = pathname.startsWith("/client") || pathname.startsWith("/care-provider");
  if (!inApp) return false;
  return !BLOCKED_FRAGMENTS.some((f) => pathname.includes(f));
}
