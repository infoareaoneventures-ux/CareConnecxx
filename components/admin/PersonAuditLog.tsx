import React, { useEffect, useState } from 'react';
import { RefreshCw, Shield, User, MessageSquare, Bell } from 'lucide-react';
import { adminService, type PersonAuditEntry as Entry } from '../../services/api';

// Per-person audit log (2026-10-22) — the Audit Log tab on the admin client and
// care provider pages. Reads agent_audit_log (server-written only) for this
// person: their own events (the notifications they were sent, Evia's actions on
// their behalf) and the team's actions (consent asked / answered / ended, links
// sent, and — next batch — every acted-for change), newest first.

interface Props { uid: string; phone?: string }

const ADMIN_LABELS: Record<string, string> = {
  admin_assist_requested: 'Consent asked: "Reply YES to allow"',
  admin_assist_granted: 'Consent given: replied YES',
  admin_assist_declined: 'Consent declined: replied NO',
  admin_assist_ended: 'Acting stopped by the team',
  admin_assist_expired: 'Consent request lapsed',
  admin_link_sent: 'Link sent by Evia',
};

const LINK_LABELS: Record<string, string> = {
  client_identity: 'identity check',
  client_payment: 'membership payment',
  caregiver_membership: 'membership payment',
  caregiver_background_check: 'background check consent',
  caregiver_payouts: 'payout setup',
  caregiver_photo: 'photo upload',
};

function humanize(eventType: string): string {
  return eventType.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function describe(e: Entry): { who: string; what: string; detail?: string; icon: 'admin' | 'self' | 'evia' | 'notice' } {
  const d = e.data || {};
  const adminName = typeof d.adminName === 'string' && d.adminName ? d.adminName : 'an admin';
  if (e.eventType in ADMIN_LABELS) {
    const base = ADMIN_LABELS[e.eventType];
    const what = e.eventType === 'admin_link_sent' ? `${base}: ${LINK_LABELS[String(d.linkKind)] ?? String(d.linkKind)}` : base;
    const detail = e.eventType === 'admin_assist_granted' && typeof d.until === 'string'
      ? `allowed until ${new Date(d.until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      : undefined;
    return { who: adminName, what, detail, icon: 'admin' };
  }
  if (e.eventType.startsWith('admin_acted_')) {
    return { who: adminName, what: typeof d.summary === 'string' ? d.summary : humanize(e.eventType.replace('admin_acted_', '')), detail: "at the person's request by phone", icon: 'admin' };
  }
  if (e.eventType === 'user_notified') {
    return { who: 'Evia', what: typeof d.title === 'string' ? d.title : humanize(String(d.transitionType ?? 'notified')), detail: typeof d.transitionType === 'string' ? d.transitionType.replace(/_/g, ' ') : undefined, icon: 'notice' };
  }
  if (e.eventType === 'message_sent') return { who: 'Evia', what: 'Text sent', detail: typeof d.preview === 'string' ? d.preview : undefined, icon: 'evia' };
  if (e.eventType === 'message_received') return { who: 'The person', what: 'Text received', icon: 'self' };
  const source = typeof d.source === 'string' ? d.source : undefined;
  return { who: source === 'site' ? 'The person (site)' : 'The person (by text)', what: humanize(e.eventType), icon: 'self' };
}

export const PersonAuditLog: React.FC<Props> = ({ uid, phone }) => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [teamOnly, setTeamOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      setEntries(await adminService.getPersonAuditLog(uid, phone));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the log');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [uid, phone]);

  const shown = teamOnly ? entries.filter((e) => e.eventType.startsWith('admin_')) : entries;

  return (
    <div className="bg-white rounded-xl border border-slate-200">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h3 className="font-semibold text-slate-900">Audit Log</h3>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input type="checkbox" checked={teamOnly} onChange={(e) => setTeamOnly(e.target.checked)} className="rounded" /> Team actions only
          </label>
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400" title="Reload"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </div>
      {error && <p className="px-5 py-3 text-sm text-red-700">{error}</p>}
      {!error && !loading && shown.length === 0 && <p className="px-5 py-6 text-sm text-slate-500">Nothing logged for this person yet.</p>}
      <ul className="divide-y divide-slate-100">
        {shown.map((e) => {
          const { who, what, detail, icon } = describe(e);
          const Icon = icon === 'admin' ? Shield : icon === 'notice' ? Bell : icon === 'evia' ? MessageSquare : User;
          const tone = icon === 'admin' ? 'text-primary-700 bg-primary-50' : icon === 'notice' ? 'text-amber-700 bg-amber-50' : 'text-slate-600 bg-slate-100';
          return (
            <li key={e.id} className="flex items-start gap-3 px-5 py-3">
              <span className={`mt-0.5 p-1.5 rounded-full shrink-0 ${tone}`}><Icon className="w-3.5 h-3.5" /></span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-900"><span className="font-medium">{who}</span> · {what}</p>
                {detail && <p className="text-xs text-slate-500 truncate">{detail}</p>}
              </div>
              <span className="text-xs text-slate-400 shrink-0">{e.timestamp ? new Date(e.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default PersonAuditLog;
