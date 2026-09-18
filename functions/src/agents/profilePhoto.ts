// The family's own profile photo — exactly what AccountSettings.tsx
// handlePhotoUpload does: the file goes to storage at
// profile_photos/{uid}/profile, and the download URL is written to all three
// places the site reads it from — users.photoURL, senior_profiles/{uid}.imageUrl
// (merge) and the Firebase Auth photoURL. Over text there is no file picker:
// the "file" is the photo the family attached, already stored by the inbound
// media handler; this copies it into the page's own path and fields. A typed
// word is never a photo (a prod account had users.photoURL === "skipped").
import * as admin from "firebase-admin";
import { defaultPhotoDeps, RecipientPhotoDeps } from "./carePlanPage";

export const PROFILE_PHOTO_PATH = (uid: string) => `profile_photos/${uid}/profile`;

export async function setClientProfilePhoto(
  uid: string,
  sourceUrl: string,
  deps: RecipientPhotoDeps = defaultPhotoDeps,
): Promise<{ photoURL: string }> {
  if (!uid) throw new Error("uid is required");
  if (!/^https?:\/\//i.test(String(sourceUrl ?? "").trim())) throw new Error("profile photo source must be an http(s) link to an image");
  const db = admin.firestore();
  const img = await deps.fetchImage(sourceUrl.trim());
  const photoURL = await deps.storeImage(PROFILE_PHOTO_PATH(uid), img.buffer, img.content_type || "image/jpeg");
  await db.collection("users").doc(uid).set({ photoURL }, { merge: true });
  await db.collection("senior_profiles").doc(uid).set({ imageUrl: photoURL }, { merge: true }).catch(() => {});
  await admin.auth().updateUser(uid, { photoURL }).catch(() => {});
  return { photoURL };
}
