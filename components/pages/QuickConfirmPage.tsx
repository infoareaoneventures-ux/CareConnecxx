import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { CheckCircle, Clock, User, AlertCircle, Loader } from 'lucide-react';
import { functions } from '../../lib/firebase';

type PageState = 'loading' | 'ready' | 'confirming' | 'confirmed' | 'expired' | 'error';

export default function QuickConfirmPage() {
  const { token } = useParams<{ token: string }>();
  const navigate  = useNavigate();

  const [state,    setState]    = useState<PageState>('loading');
  const [task,     setTask]     = useState<any>(null);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    if (!token) { setState('error'); return; }
    loadTask(token);
  }, [token]);

  async function loadTask(t: string) {
    if (!functions) { setState('error'); return; }
    try {
      // Token-scoped read via callable — the page never queries agent_tasks
      // directly, so the collection stays admin/server-scoped in rules.
      const getTask = functions.httpsCallable('v1-getAgentTaskByToken');
      const res: any = (await getTask({ token: t })).data;

      if (res?.status === 'completed') { setState('confirmed'); return; }
      if (res?.status === 'expired')   { setState('expired'); return; }
      if (res?.status !== 'ready')     { setState('error'); return; }

      setTask({ time: res.time });
      setSelected(res.selected);
      setState('ready');
    } catch {
      setState('error');
    }
  }

  async function confirmBooking() {
    if (!task || !selected || !token) return;
    if (!functions) { setState('error'); return; }
    setState('confirming');

    try {
      // Commit the confirmation server-side. The callable validates the token,
      // marks the task completed, and records the approval via the Admin SDK —
      // the web no longer writes agent_tasks / agent_approvals directly.
      const confirm = functions.httpsCallable('v1-confirmAgentTask');
      await confirm({ token });
      setState('confirmed');
    } catch {
      setState('error');
    }
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  if (state === 'loading') {
    return (
      <Screen>
        <Loader className="w-10 h-10 text-teal-500 animate-spin mx-auto mb-4" />
        <p className="text-ink-600 text-center">Loading your booking…</p>
      </Screen>
    );
  }

  if (state === 'confirmed') {
    return (
      <Screen>
        <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
        <h1 className="text-2xl font-bold text-ink-900 text-center mb-2">Confirmed!</h1>
        <p className="text-ink-600 text-center">
          {selected?.name ?? 'Your caregiver'} is booked. You'll receive a text when they arrive.
        </p>
      </Screen>
    );
  }

  if (state === 'expired') {
    return (
      <Screen>
        <Clock className="w-12 h-12 text-amber-400 mx-auto mb-4" />
        <h1 className="text-xl font-bold text-ink-900 text-center mb-2">This link has expired</h1>
        <p className="text-ink-600 text-center text-sm">
          Replacement requests expire after 30 minutes. Please open the CareConnecxx app to find a caregiver.
        </p>
      </Screen>
    );
  }

  if (state === 'error') {
    return (
      <Screen>
        <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
        <h1 className="text-xl font-bold text-ink-900 text-center mb-2">Something went wrong</h1>
        <p className="text-ink-600 text-center text-sm">Please open the app or contact support.</p>
      </Screen>
    );
  }

  // ── Ready state ────────────────────────────────────────────────────────────

  return (
    <Screen>
      <div className="w-full max-w-sm mx-auto">
        {/* Caregiver card */}
        <div className="bg-white rounded-2xl shadow-md p-6 mb-6 border hairline">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-full bg-teal-50 flex items-center justify-center shrink-0">
              <User className="w-7 h-7 text-teal-500" />
            </div>
            <div>
              <p className="font-bold text-ink-900 text-lg">{selected?.name}</p>
              <p className="text-ink-600 text-sm">
                {selected?.rating}⭐ · ${selected?.hourlyRate}/hr
                {selected?.previouslyBooked && (
                  <span className="ml-2 text-teal-600 font-medium">• booked before</span>
                )}
              </p>
            </div>
          </div>

          {task?.time && (
            <div className="flex items-center gap-2 text-ink-600 text-sm">
              <Clock className="w-4 h-4 shrink-0" />
              <span>Today · {task.time}</span>
            </div>
          )}
        </div>

        {/* Confirm button */}
        <button
          onClick={confirmBooking}
          disabled={state === 'confirming'}
          className="w-full py-5 rounded-2xl bg-teal-500 hover:bg-teal-600 active:bg-teal-700 text-white font-bold text-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-3"
        >
          {state === 'confirming' ? (
            <><Loader className="w-5 h-5 animate-spin" /> Confirming…</>
          ) : (
            `Confirm ${selected?.name?.split(' ')[0] ?? 'Caregiver'}`
          )}
        </button>

        <p className="text-center text-xs text-ink-400 mt-4">
          Nothing is booked until you tap Confirm.
        </p>
      </div>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper-50 flex flex-col items-center justify-center p-6">
      {children}
    </div>
  );
}
