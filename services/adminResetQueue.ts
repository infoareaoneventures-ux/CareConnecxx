import { db } from '../lib/firebase';

// Admin "Reset Account" — client side of the adminResetQueue Firestore-trigger
// (functions/src/triggers/resetAccountQueue.ts). Writes the request doc, then
// waits for the trigger to stamp processedAt so the admin sees what actually
// happened. Before 2026-09-25 both admin managers toasted "data will be wiped
// in seconds" the moment the doc was added and dropped the account from the
// list — while the trigger was rejecting the request (empty phone) every time.

export interface AdminResetResult {
  success: boolean;
  error?: string;
  note?: string;
  counts?: Record<string, number>;
  errors?: string[];
}

export async function queueAdminReset(
  req: { uid: string; phone?: string | null; role: 'client' | 'caregiver' },
  opts: { timeoutMs?: number } = {},
): Promise<AdminResetResult> {
  if (!db) throw new Error('Not connected');
  const ref = db.collection('adminResetQueue').doc();
  await ref.set({
    type: 'reset_account',
    uid: req.uid,
    phone: req.phone ?? '',
    role: req.role,
    createdAt: new Date(),
  });
  return new Promise<AdminResetResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('The reset is still running — check the account again in a minute.'));
    }, opts.timeoutMs ?? 90_000);
    const unsubscribe = ref.onSnapshot(
      (snap) => {
        const d = snap.data();
        if (!d || !d.processedAt) return;
        clearTimeout(timeout);
        unsubscribe();
        if (d.error) resolve({ success: false, error: String(d.error) });
        else resolve({
          success: !!d.success,
          note: typeof d.note === 'string' ? d.note : undefined,
          counts: d.counts as Record<string, number> | undefined,
          errors: Array.isArray(d.errors) ? (d.errors as string[]) : undefined,
        });
      },
      (err) => { clearTimeout(timeout); reject(err); },
    );
  });
}
