import React, { useEffect, useState } from 'react';
import { Phone, Square, RefreshCw, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { adminService, type AdminAssistState } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

// Admin assist consent strip (2026-10-22) — sits under the person's name on the
// admin client / care provider pages. "Act for this person" texts the account's
// phone "Reply YES to allow"; the strip follows adminAssist/{uid} live (written
// only by the server): waiting → allowed (with the window) → ended / declined /
// expired. The acting controls themselves unlock in the next batch; the strip,
// the consent text and the audit entries are the foundation.

interface Props {
  uid: string;
  role: 'client' | 'caregiver';
  personName: string;
  phone?: string;
  onToast: (msg: string, type: 'success' | 'error') => void;
}

const fmtTime = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

export const AdminAssistStrip: React.FC<Props> = ({ uid, role, personName, phone, onToast }) => {
  const { currentUser } = useCareConnex();
  const [state, setState] = useState<AdminAssistState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setState(null);
    return adminService.watchAdminAssist(uid, setState);
  }, [uid]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const untilMs = state?.until ? Date.parse(state.until) : NaN;
  const active = state?.status === 'granted' && Number.isFinite(untilMs) && untilMs > now;
  const waiting = state?.status === 'requested';
  const waitedMs = waiting && state?.requestedAt ? now - Date.parse(state.requestedAt) : 0;
  const waitLapsed = waiting && waitedMs > 15 * 60 * 1000;

  const queue = async (type: 'request_consent' | 'end_consent') => {
    if (!currentUser) { onToast('Not signed in as an admin', 'error'); return; }
    setBusy(true);
    try {
      await adminService.queueAdminAssist({
        type, uid, role,
        adminUid: currentUser.uid,
        adminName: currentUser.displayName || currentUser.email || currentUser.uid,
      });
      onToast(type === 'request_consent' ? `Consent text sent to ${personName}` : 'Acting stopped', 'success');
    } catch {
      onToast('Could not send the request', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remaining = active ? Math.max(0, untilMs - now) : 0;
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
  const first = personName.split(/\s+/)[0] || 'this person';

  return (
    <div className={`px-5 py-2.5 border-b text-sm flex items-center gap-3 flex-wrap ${active ? 'bg-emerald-50 border-emerald-200' : waiting && !waitLapsed ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
      {active ? (
        <>
          <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="text-emerald-900">
            Acting for <strong>{first}</strong>, allowed by YES at {fmtTime(state?.grantedAt)}, until {fmtTime(state?.until)}
            <span className="ml-2 font-mono text-xs text-emerald-700">{mm}:{ss}</span>
          </span>
          <button onClick={() => queue('end_consent')} disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100 disabled:opacity-50">
            <Square className="w-3 h-3" /> Stop
          </button>
        </>
      ) : waiting && !waitLapsed ? (
        <>
          <Clock className="w-4 h-4 text-amber-600 shrink-0" />
          <span className="text-amber-900">
            Consent text sent to {phone || state?.phone || 'their phone'} at {fmtTime(state?.requestedAt)}, waiting for YES
          </span>
          {waitedMs > 90 * 1000 && (
            <button onClick={() => queue('request_consent')} disabled={busy}
              className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border border-amber-300 bg-white text-amber-800 hover:bg-amber-100 disabled:opacity-50">
              <RefreshCw className="w-3 h-3" /> Resend
            </button>
          )}
        </>
      ) : (
        <>
          {state?.status === 'declined' && <span className="inline-flex items-center gap-1.5 text-red-700"><AlertCircle className="w-4 h-4" /> {first} replied NO at {fmtTime(state.endedAt)}.</span>}
          {(state?.status === 'expired' || waitLapsed) && <span className="inline-flex items-center gap-1.5 text-slate-600"><AlertCircle className="w-4 h-4" /> Expired, ask again.</span>}
          {state?.status === 'ended' && <span className="text-slate-600">Last session ended at {fmtTime(state.endedAt)}.</span>}
          {state?.status === 'granted' && !active && <span className="text-slate-600">The hour ran out at {fmtTime(state.until)}.</span>}
          <button onClick={() => queue('request_consent')} disabled={busy || !phone}
            title={!phone ? 'No phone number on this account yet' : undefined}
            className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50">
            <Phone className="w-3.5 h-3.5" /> Act for this {role === 'client' ? 'client' : 'care provider'}
          </button>
        </>
      )}
    </div>
  );
};

export default AdminAssistStrip;
