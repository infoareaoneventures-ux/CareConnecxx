// The post-a-job form keeps a draft in the browser (2026-11-11, fix plan Wave 3: "the form loses everything if you're
// signed out"). Saved on every change, per signed-in account, restored on the next visit, cleared when the job is
// posted or the family chooses to start over. A week old or unreadable → ignored. Never throws (private windows,
// blocked storage).
import type { JobPostFormData } from './types';

const PREFIX = 'evia.postJobDraft.';
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PostJobDraft { step: number; data: JobPostFormData; savedAt: number }

const keyFor = (uid: string) => `${PREFIX}${uid}`;

export function saveDraft(uid: string | undefined, step: number, data: JobPostFormData, now: number = Date.now()): void {
  if (!uid) return;
  try { window.localStorage.setItem(keyFor(uid), JSON.stringify({ step, data, savedAt: now } satisfies PostJobDraft)); } catch { /* storage unavailable */ }
}

export function loadDraft(uid: string | undefined, now: number = Date.now()): PostJobDraft | null {
  if (!uid) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(uid));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<PostJobDraft>;
    if (!d || typeof d.savedAt !== 'number' || !d.data || typeof d.step !== 'number') return null;
    if (now - d.savedAt > DRAFT_MAX_AGE_MS) { clearDraft(uid); return null; }
    return d as PostJobDraft;
  } catch { return null; }
}

export function clearDraft(uid: string | undefined): void {
  if (!uid) return;
  try { window.localStorage.removeItem(keyFor(uid)); } catch { /* storage unavailable */ }
}

/** A draft that still holds the untouched starting form is not worth restoring. */
export function isMeaningfulDraft(d: PostJobDraft, initial: JobPostFormData): boolean {
  return JSON.stringify(d.data) !== JSON.stringify(initial) || d.step > 0;
}
