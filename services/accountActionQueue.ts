import { db } from '../lib/firebase';

// Client side of the Firestore-trigger queue workaround (see
// functions/src/accountRecovery.ts and functions/src/triggers/
// accountActionQueue.ts for why: a brand-new public Cloud Function can't get
// its invoker IAM set on this project). Writes a request doc directly to
// Firestore — a plain client write, no Cloud Function call — then listens
// for the trigger to fill in status/result/error, the same way a direct
// callable would have returned a response.

export type AccountActionType =
  | 'request_phone_change'
  | 'start_phone_verification'
  | 'confirm_phone_change'
  | 'request_email_change'
  | 'confirm_email_change'
  | 'approve_email_change'
  | 'start_email_change_fallback'
  | 'confirm_email_change_fallback'
  | 'resend_email_confirmation'
  | 'delete_account'
  | 'set_caregiver_pause_status';

export async function submitAccountAction<T extends Record<string, unknown> = { success: true }>(
  type: AccountActionType,
  data: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  if (!db) throw new Error('Not connected');
  const ref = db.collection('account_action_requests').doc();
  await ref.set({ type, status: 'pending', createdAt: new Date().toISOString(), ...data });

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('This is taking longer than expected — please try again.'));
    }, opts.timeoutMs ?? 30000);

    const unsubscribe = ref.onSnapshot(
      (snap) => {
        const d = snap.data();
        if (!d || d.status === 'pending') return;
        clearTimeout(timeout);
        unsubscribe();
        if (d.status === 'done') resolve((d.result as T) ?? ({ success: true } as unknown as T));
        else reject(new Error((d.error as string) || 'Something went wrong. Please try again.'));
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}
