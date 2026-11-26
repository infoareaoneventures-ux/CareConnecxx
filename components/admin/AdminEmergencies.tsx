import React, { useEffect, useState } from 'react';
import { Siren, Phone, Check, MessageSquare } from 'lucide-react';
import { dbService } from '../../services/api';

// Emergencies (2026-11-26) — every emergency text, on its own tab: who, what they said, who Evia texted, and the two
// actions that matter (call them, open their conversation). Written by functions/src/safety/emergency.ts.

interface Notified { name?: string; phone?: string; relation?: string; status?: string }
export interface EmergencyAlert {
  id: string; type?: string; kind?: string; crisisKind?: string; name?: string; seniorName?: string; phone?: string;
  userId?: string; role?: string; said?: string; crisisText?: string; message?: string; channel?: string;
  notified?: Notified[]; note?: string; resolved?: boolean; createdAt?: string; resolvedAt?: string;
}

const KIND: Record<string, string> = { medical: 'Medical emergency', emotional: 'Self-harm risk', help: 'Asked for help' };
const kindOf = (a: EmergencyAlert) => a.kind || a.crisisKind || (a.type === 'cara_medical_emergency' ? 'medical' : 'help');

interface Props {
  onOpen: (uid: string, role: 'client' | 'caregiver') => void;
  onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const AdminEmergencies: React.FC<Props> = ({ onOpen, onShowToast }) => {
  const [rows, setRows] = useState<EmergencyAlert[] | null>(null);
  const [show, setShow] = useState<'open' | 'resolved'>('open');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => dbService.subscribeEmergencyAlerts(
    (data) => setRows(data as EmergencyAlert[]),
    () => setFailed(true),
  ), []);

  const resolve = async (id: string) => {
    setBusy(id);
    try {
      await dbService.resolveAdminAlert(id);
      onShowToast('Marked resolved', 'success');
    } catch (err) {
      console.error('resolve emergency:', err);
      onShowToast('Could not mark it resolved. Try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const open = rows?.filter((r) => !r.resolved) ?? [];
  const list = show === 'open' ? open : rows?.filter((r) => r.resolved) ?? [];

  return (
    <div className="p-5 max-w-4xl">
      <h3 className="font-bold text-slate-900 text-lg">Emergencies</h3>
      <p className="text-sm text-slate-500 mb-4">Every emergency message. Evia has already told them to call 911; follow up in person.</p>
      <div className="flex gap-2 mb-4">
        {(['open', 'resolved'] as const).map((s) => (
          <button key={s} onClick={() => setShow(s)} aria-pressed={show === s}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold capitalize ${show === s ? 'bg-primary-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>
            {s}{s === 'open' ? ` (${open.length})` : ''}
          </button>
        ))}
      </div>
      {failed && <p className="text-sm text-red-700 mb-3">Could not load emergencies. Refresh the page.</p>}
      {rows === null && !failed && <p className="text-sm text-slate-500">Loading…</p>}
      {rows !== null && !failed && list.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-500 text-sm">No {show} emergencies.</div>
      )}
      <ul className="space-y-3">
        {list.map((a) => {
          const kind = kindOf(a);
          const said = a.said || a.crisisText;
          return (
            <li key={a.id} className={`rounded-xl border p-4 ${a.resolved ? 'bg-white border-slate-200' : 'bg-red-50/60 border-red-200 border-l-4 border-l-red-500'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <Siren className="w-4 h-4 text-red-600 shrink-0" />
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-600 text-white">{KIND[kind] ?? kind}</span>
                <span className="font-semibold text-slate-900">{a.name || a.seniorName || a.phone || 'Unknown'}</span>
                {a.role && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{a.role === 'caregiver' ? 'care provider' : 'family'}</span>}
                {a.channel === 'web' && <span className="text-xs text-slate-500">website chat</span>}
                {a.createdAt && <span className="text-xs text-slate-500 ml-auto">{new Date(a.createdAt).toLocaleString()}</span>}
              </div>
              {said ? <p className="mt-2 text-sm text-slate-900">“{said}”</p> : <p className="mt-2 text-sm text-slate-700">{a.message}</p>}
              <div className="mt-2 text-sm text-slate-600">
                {a.notified?.length
                  ? <ul>{a.notified.map((n, i) => (
                      <li key={i}>{n.status === 'sent' ? 'Texted' : 'NOT delivered to'} {n.name} ({n.relation}{n.phone ? `, ${n.phone}` : ''}){n.status && n.status !== 'sent' ? `: ${n.status.replace(/_/g, ' ')}` : ''}</li>
                    ))}</ul>
                  : <p>Nobody else was texted.</p>}
                {a.note && <p className="text-slate-500">{a.note}</p>}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {a.phone && (
                  <a href={`tel:${a.phone}`} className="inline-flex items-center gap-1.5 text-sm font-semibold bg-red-600 text-white px-3 py-1.5 rounded-lg hover:bg-red-700">
                    <Phone className="w-4 h-4" /> Call {a.phone}
                  </a>
                )}
                {a.userId && (
                  <button onClick={() => onOpen(a.userId!, a.role === 'caregiver' ? 'caregiver' : 'client')}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold bg-white border border-slate-200 text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-50">
                    <MessageSquare className="w-4 h-4" /> Open conversation
                  </button>
                )}
                {!a.resolved && (
                  <button onClick={() => resolve(a.id)} disabled={busy === a.id}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold bg-white text-emerald-700 border border-emerald-200 px-3 py-1.5 rounded-lg hover:bg-emerald-50 disabled:opacity-50">
                    <Check className="w-4 h-4" /> {busy === a.id ? 'Resolving…' : 'Mark resolved'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default AdminEmergencies;
