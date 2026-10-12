// The signup role as the web sends it. The site's links moved from
// /start?role=caregiver to /start?role=care-provider (2026-10-12); the server
// keeps the legacy "caregiver" value internally (userType, collections, steps)
// and accepts every spelling of the new one.
export function isCareProviderRole(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "caregiver" || v === "care-provider" || v === "care_provider" || v === "careprovider" || v === "care provider";
}
