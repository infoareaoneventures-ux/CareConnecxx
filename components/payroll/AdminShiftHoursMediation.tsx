import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { shiftHoursService } from '../../services/api';

function toLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const AdminShiftHoursMediation: React.FC = () => {
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<any | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const unsub = shiftHoursService.subscribeForAdmin(setRows);
    return () => { try { (unsub as any)?.(); } catch {} };
  }, []);

  useEffect(() => {
    if (resolveTarget) {
      setStart(toLocal(resolveTarget.submittedStartTime));
      setEnd(toLocal(resolveTarget.submittedEndTime));
      setNote('');
    }
  }, [resolveTarget]);

  const disputed = rows.filter(r => r.status === 'disputed_admin_review');
  const failed = rows.filter(r => r.status === 'payment_failed');

  const resolve = async () => {
    if (!resolveTarget) return;
    setBusy(resolveTarget.id);
    try {
      await shiftHoursService.adminResolve(
        resolveTarget.appointmentId,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        note.trim() || undefined,
      );
      setMsg('Resolved');
      setResolveTarget(null);
    } catch (e: any) {
      setMsg(e?.message || 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const retry = async (row: any) => {
    setBusy(row.id);
    try {
      const res = await shiftHoursService.retryPayment(row.appointmentId);
      setMsg(res.success ? 'Retry succeeded' : (res.error || 'Retry failed'));
    } catch (e: any) {
      setMsg(e?.message || 'Retry failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-900">Shift hours — admin mediation</h2>
        {msg && <span className="text-sm text-primary-600">{msg}</span>}
      </header>

      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-accent-500" />
          Disputes ({disputed.length})
        </h3>
        {disputed.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500 text-center">No open disputes.</div>
        ) : (
          <div className="space-y-2">
            {disputed.map(r => (
              <div key={r.id} className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-medium text-slate-900">{r.caregiverName} × {r.clientName}</p>
                    <p className="text-xs text-slate-500">Appointment {r.appointmentId}</p>
                  </div>
                  <button
                    onClick={() => setResolveTarget(r)}
                    className="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-sm font-medium"
                  >
                    Resolve
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs text-slate-500 mb-1">Caregiver submitted</p>
                    <p className="font-medium">{r.submittedTotalHours}h</p>
                    <p className="text-xs text-slate-400">
                      {new Date(r.submittedStartTime).toLocaleString()} → {new Date(r.submittedEndTime).toLocaleString()}
                    </p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs text-slate-500 mb-1">Client proposed</p>
                    <p className="font-medium">{r.proposedTotalHours}h</p>
                    <p className="text-xs text-slate-400">
                      {new Date(r.proposedStartTime).toLocaleString()} → {new Date(r.proposedEndTime).toLocaleString()}
                    </p>
                    {r.proposalReason && <p className="text-xs text-slate-500 mt-1">{r.proposalReason}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-red-500" />
          Payment failures ({failed.length})
        </h3>
        {failed.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500 text-center">No payment failures.</div>
        ) : (
          <div className="space-y-2">
            {failed.map(r => (
              <div key={r.id} className="bg-white rounded-xl border border-red-200 p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-slate-900">{r.caregiverName} × {r.clientName}</p>
                  <p className="text-sm text-slate-600">{r.finalTotalHours || r.submittedTotalHours}h · ${r.grossPay?.toFixed(2) || '—'}</p>
                  <p className="text-xs text-red-600 mt-1">{r.stripeFailureReason} · attempt {r.paymentAttemptCount}</p>
                </div>
                <button
                  onClick={() => retry(r)}
                  disabled={busy === r.id}
                  className="px-3 py-1.5 rounded-lg border border-red-300 text-red-700 text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                >
                  Retry now
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {resolveTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setResolveTarget(null)}>
          <div className="bg-white rounded-2xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-slate-900 mb-4">Resolve dispute</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Final start</label>
                <input type="datetime-local" value={start} onChange={e => setStart(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Final end</label>
                <input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Resolution note</label>
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-none" />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setResolveTarget(null)} className="flex-1 py-2 rounded-lg border border-slate-200 text-slate-700">Cancel</button>
              <button onClick={resolve} disabled={busy === resolveTarget.id}
                className="flex-1 py-2 rounded-lg bg-primary-600 text-white font-medium disabled:opacity-50">
                {busy === resolveTarget.id ? 'Saving…' : 'Save resolution'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminShiftHoursMediation;
