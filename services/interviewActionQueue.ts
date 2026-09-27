import { db } from '../lib/firebase';

// Client side of the Firestore-trigger queue workaround (see
// functions/src/triggers/interviewActionQueue.ts and services/
// accountActionQueue.ts for the identical pattern used there — a brand-new
// public Cloud Function can't get its invoker IAM set on this project).
// Writes a request doc directly to Firestore — a plain client write, no
// Cloud Function call — then listens for the trigger to fill in
// status/result/error, the same way a direct callable would have returned
// a response.

export interface RespondToInterviewResult {
  status: 'accepted' | 'declined';
  interviewId: string;
  callUrl: string | null;
}

// Accept / Decline only (2026-09-27): proposing a new time is a pending
// proposal on the same interview (reschedulePendingTime), written directly —
// see JobBoard.tsx handleRescheduleInterview.
export async function respondToInterviewRequest(params: {
  caregiverId: string;
  interviewId: string;
  decision: 'accept' | 'decline';
}, opts: { timeoutMs?: number } = {}): Promise<RespondToInterviewResult> {
  if (!db) throw new Error('Not connected');
  const ref = db.collection('interview_action_requests').doc();
  await ref.set({
    type: 'respond_to_interview',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...params,
  });

  return new Promise<RespondToInterviewResult>((resolve, reject) => {
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
        if (d.status === 'done') resolve(d.result as RespondToInterviewResult);
        else reject(new Error((d.error as string) || 'Something went wrong. Please try again.'));
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}
