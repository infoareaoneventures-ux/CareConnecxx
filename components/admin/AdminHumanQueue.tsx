import React, { useEffect, useState } from 'react';
import { UserRound, MessageSquare, Clock } from 'lucide-react';
import { adminService, type HumanQueueRow } from '../../services/api';

// "Needs a human" (2026-10-22) — everyone whose human-mode switch is on, in one
// list: who, their last text, how long they have been waiting, how many texts
// are unanswered. Click → that person's page, Messages tab.

interface Props { onOpen: (uid: string, role: 'client' | 'caregiver') => void }

function waiting(iso?: string): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h ${mins % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export const AdminHumanQueue: React.FC<Props> = ({ onOpen }) => {
  const [rows, setRows] = useState<HumanQueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => adminService.watchHumanQueue((r, err) => { if (err) setError(err); setRows(r); }), []);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30000); return () => clearInterval(t); }, []);

  return (
    <div className="p-5 max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-bold text-slate-900 text-lg">Needs a human</h3>
          <p className="text-sm text-slate-500">Everyone whose thread the team holds. Evia is not replying to them; answer from their Messages tab.</p>
        </div>
        <span className="text-sm text-slate-500">{rows ? `${rows.length} waiting` : 'Loading…'}</span>
      </div>
      {error && <p className="text-sm text-red-700 mb-3">{error}</p>}
      {rows && rows.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-500 text-sm">Nobody is waiting for a human right now.</div>
      )}
      <ul className="space-y-2">
        {rows?.map((r) => (
          <li key={r.uid}>
            <button onClick={() => onOpen(r.uid, r.role)} className="w-full text-left bg-white rounded-xl border border-slate-200 hover:border-primary-300 hover:bg-primary-50/40 px-4 py-3 flex items-start gap-3 transition-colors">
              <span className="mt-0.5 p-2 rounded-full bg-rose-50 text-rose-600 shrink-0"><UserRound className="w-4 h-4" /></span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-900">{r.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{r.role === 'caregiver' ? 'care provider' : 'client'}</span>
                  {r.unread > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-600 text-white">{r.unread} unanswered</span>}
                  <span className="text-xs text-slate-500 inline-flex items-center gap-1 ml-auto"><Clock className="w-3 h-3" /> waiting {waiting(r.lastAt || r.since)}</span>
                </div>
                <p className="text-sm text-slate-700 truncate mt-1 inline-flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0" />{r.lastText || 'No text yet since the handoff'}</p>
                <p className="text-xs text-slate-400 mt-0.5">{r.byName ? `Handed off by ${r.byName}` : 'Handed off'}{r.reason === 'low_confidence' ? " — Evia wasn't sure enough to answer" : r.reason === 'asked_for_human' ? ' — they asked for a person' : ''}{r.phone ? ` · ${r.phone}` : ''}</p>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default AdminHumanQueue;
