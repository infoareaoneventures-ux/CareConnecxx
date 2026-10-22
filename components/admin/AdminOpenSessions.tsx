import React, { useEffect, useState } from 'react';
import { Eye, Shield, ExternalLink, Square, Clock } from 'lucide-react';
import { adminService, type OpenSessionRow } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

// Open sessions (2026-10-22) — every account someone on the team is currently
// acting for or viewing, so a forgotten session is visible: the person, which
// admin, acting / viewing / window open, since when. "Go there" opens the
// person's page; "End" closes the window (acting) or your own view.

interface Props { onOpen: (uid: string, role: 'client' | 'caregiver') => void; onToast: (msg: string, type: 'success' | 'error') => void }

const fmt = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
function ago(iso?: string): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export const AdminOpenSessions: React.FC<Props> = ({ onOpen, onToast }) => {
  const { currentUser: ctxUser, adminUser, actingFor, stopActing } = useCareConnex();
  const me = adminUser ?? ctxUser;
  const [rows, setRows] = useState<OpenSessionRow[] | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => adminService.watchOpenSessions(setRows), []);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30000); return () => clearInterval(t); }, []);

  const end = async (r: OpenSessionRow) => {
    if (!me) return;
    if (r.kind === 'view') {
      if (r.adminUid === me.uid) { if (actingFor?.uid === r.uid) stopActing(); await adminService.clearAdminPresence(me.uid).catch(() => {}); onToast('Your view ended', 'success'); }
      else onToast(`${r.adminName} has to close that view themselves`, 'error');
      return;
    }
    try {
      if (actingFor?.uid === r.uid) stopActing();
      await adminService.queueAdminAssist({ type: 'end_consent', uid: r.uid, role: r.role, adminUid: me.uid, adminName: me.displayName || me.email || me.uid });
      onToast(`Ended the window for ${r.personName}`, 'success');
    } catch { onToast('Could not end the window', 'error'); }
  };

  return (
    <div className="p-5 max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-bold text-slate-900 text-lg">Open sessions</h3>
          <p className="text-sm text-slate-500">Accounts someone on the team is acting for or viewing right now. A YES window ends on its own after an hour; a view drops off a couple of minutes after the tab closes.</p>
        </div>
        <span className="text-sm text-slate-500">{rows ? `${rows.length} open` : 'Loading…'}</span>
      </div>
      {rows && rows.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-500 text-sm">No open sessions.</div>
      )}
      <ul className="space-y-2">
        {rows?.map((r) => (
          <li key={r.key} className="bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-start gap-3">
            <span className={`mt-0.5 p-2 rounded-full shrink-0 ${r.kind === 'view' ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-600'}`}>
              {r.kind === 'view' ? <Eye className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-900">{r.personName}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{r.role === 'caregiver' ? 'care provider' : 'client'}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${r.kind === 'view' ? 'bg-slate-200 text-slate-700' : r.kind === 'act' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                  {r.kind === 'view' ? 'viewing' : r.kind === 'act' ? 'acting' : 'YES window open, not on their pages'}
                </span>
                <span className="text-xs text-slate-500 inline-flex items-center gap-1 ml-auto"><Clock className="w-3 h-3" /> since {fmt(r.since)} · {ago(r.since)}</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">{r.adminName}{r.adminUid === me?.uid ? ' (you)' : ''}{r.until ? ` · window until ${fmt(r.until)}` : ''}{r.lastSeen && r.kind === 'view' ? ` · last seen ${ago(r.lastSeen)} ago` : ''}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => onOpen(r.uid, r.role)} className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
                <ExternalLink className="w-3 h-3" /> Go there
              </button>
              <button onClick={() => end(r)} className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50">
                <Square className="w-3 h-3" /> End
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default AdminOpenSessions;
