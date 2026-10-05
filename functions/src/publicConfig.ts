// config/public — the few values the site must agree with the server on, published
// FROM the functions env so the browser never carries its own copy (founder,
// 2026-10-04: the site's git-ignored .env had a stale VITE_LINQ_PHONE_NUMBER and
// every static "Text Evia" link pointed at an old line). Public read, server write
// only (firestore.rules). Refreshed on every /start session and by the daily
// transport-badge job, so the doc tracks the env within a day of any change.
import * as admin from "firebase-admin";

export interface PublicConfig {
  /** The number Evia texts from — what every "Text Evia" link on the site should open. */
  eviaPhone: string;
  updatedAt: string;
}

export async function publishPublicConfig(): Promise<void> {
  const eviaPhone = (process.env.LINQ_PHONE_NUMBER ?? "").trim();
  if (!eviaPhone) return;
  const doc: PublicConfig = { eviaPhone, updatedAt: new Date().toISOString() };
  await admin.firestore().collection("config").doc("public").set(doc, { merge: true });
}
