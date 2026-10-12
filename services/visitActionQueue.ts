import { db } from '../lib/firebase';

// Client side of the Firestore-trigger queue workaround (see
// functions/src/triggers/visitActionQueue.ts, and services/accountActionQueue.ts
// / services/interviewActionQueue.ts for the identical pattern — a brand-new
// public Cloud Function can't get its invoker IAM set on this project). The
// caregiver's Start Shift / End / ✕ / Cancel Booking / Log Hours buttons write a
// request doc here (a plain client write) and listen for the trigger to settle
// it; the server (functions/src/shifts/visitActions.ts — the same functions
// Evia's START / FINISH / CANCEL / LOG use) runs the checks the browser used to
// run alone: the membership + background gate, the 15-minute Start window,
// one visit at a time, the 24-hour cancel rule. firestore.rules no longer lets
// the caregiver write those statuses on shifts/{id} directly (2026-10-11).

export type VisitActionType = 'start_visit' | 'end_visit' | 'cancel_visit' | 'cancel_booking' | 'log_hours';

export type VisitRefusalReason =
  | 'not_found' | 'not_yours' | 'membership' | 'background' | 'another_in_progress'
  | 'not_scheduled' | 'overdue' | 'too_early' | 'not_in_progress' | 'not_missed' | 'bad_times';

/** A refusal is a normal settled outcome — the page shows `message` in its toast. */
export interface VisitActionRefusal { ok: false; reason: VisitRefusalReason; message: string; status?: string }
export type StartVisitResult = { ok: true; shiftId: string; status: 'in-progress'; alreadyStarted: boolean; startedAt: string } | VisitActionRefusal;
export type EndVisitResult = { ok: true; shiftId: string; status: 'completed'; alreadyCompleted: boolean; completedAt: string } | VisitActionRefusal;
export type CancelVisitResult = { ok: true; shiftId: string; status: 'needs_replacement' | 'cancelled' } | VisitActionRefusal;
export type CancelBookingResult = { ok: true; shiftId: string; anyUrgent: boolean; count: number } | VisitActionRefusal;
export type LogHoursResult = { ok: true; shiftId: string; status: 'completed' } | VisitActionRefusal;

export interface VisitActionPayloads {
  start_visit: { caregiverId: string; shiftId: string };
  end_visit: { caregiverId: string; shiftId: string; closingNote?: string };
  cancel_visit: { caregiverId: string; shiftId: string };
  cancel_booking: { caregiverId: string; shiftId: string };
  /** `startedAt` / `completedAt` are ISO instants of the actual times entered in the modal. */
  log_hours: { caregiverId: string; shiftId: string; startedAt: string; completedAt: string; tasksCompleted: string[]; completionNotes?: string };
}
export interface VisitActionResults {
  start_visit: StartVisitResult;
  end_visit: EndVisitResult;
  cancel_visit: CancelVisitResult;
  cancel_booking: CancelBookingResult;
  log_hours: LogHoursResult;
}

export async function submitVisitAction<T extends VisitActionType>(
  type: T,
  data: VisitActionPayloads[T],
  opts: { timeoutMs?: number } = {},
): Promise<VisitActionResults[T]> {
  if (!db) throw new Error('Not connected');
  const ref = db.collection('visit_action_requests').doc();
  // Optional fields must be absent, not undefined (Firestore rejects undefined).
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== ''));
  await ref.set({ type, status: 'pending', createdAt: new Date().toISOString(), ...clean });

  return new Promise<VisitActionResults[T]>((resolve, reject) => {
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
        if (d.status === 'done') resolve(d.result as VisitActionResults[T]);
        else reject(new Error((d.error as string) || 'Something went wrong. Please try again.'));
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}
