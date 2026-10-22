import React, { useEffect, useState } from 'react';
import { Send, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { adminService } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

// Send-link buttons (2026-10-22) — the steps the team never does for a person:
// identity check, membership payment, background-check consent, payout setup
// (and the photo upload page). Each button queues a request the server fulfils
// by having Evia text the same link she would send on her own. The override
// buttons next to these stay for testing (founder, 2026-10-22).

type LinkKind = 'client_identity' | 'client_payment' | 'caregiver_membership' | 'caregiver_background_check' | 'caregiver_payouts' | 'caregiver_photo';

const LINKS: Record<'client' | 'caregiver', Array<{ kind: LinkKind; label: string }>> = {
  client: [
    { kind: 'client_identity', label: 'Identity check link' },
    { kind: 'client_payment', label: 'Membership payment link' },
  ],
  caregiver: [
    { kind: 'caregiver_membership', label: 'Membership payment link' },
    { kind: 'caregiver_background_check', label: 'Background check consent link' },
    { kind: 'caregiver_payouts', label: 'Payout setup link' },
    { kind: 'caregiver_photo', label: 'Photo upload link' },
  ],
};

interface Props {
  uid: string;
  role: 'client' | 'caregiver';
  onToast: (msg: string, type: 'success' | 'error') => void;
}

interface Outcome { sending?: boolean; sentAt?: string; error?: string }

export const AdminSendLinks: React.FC<Props> = ({ uid, role, onToast }) => {
  const { currentUser: ctxUser, adminUser } = useCareConnex();
  const currentUser = adminUser ?? ctxUser;
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  useEffect(() => { setOutcomes({}); }, [uid]);

  const send = async (kind: LinkKind) => {
    if (!currentUser) { onToast('Not signed in as an admin', 'error'); return; }
    setOutcomes((o) => ({ ...o, [kind]: { sending: true } }));
    try {
      const requestId = await adminService.queueAdminAssist({
        type: 'send_link', uid, role, linkKind: kind,
        adminUid: currentUser.uid,
        adminName: currentUser.displayName || currentUser.email || currentUser.uid,
      });
      // Follow the request until the server says what happened.
      adminService.watchAdminAssistRequest(requestId, ({ error }) => {
        if (error) {
          setOutcomes((o) => ({ ...o, [kind]: { error } }));
          onToast(error, 'error');
        } else {
          setOutcomes((o) => ({ ...o, [kind]: { sentAt: new Date().toISOString() } }));
          onToast('Link sent by Evia', 'success');
        }
      });
    } catch {
      setOutcomes((o) => ({ ...o, [kind]: { error: 'Could not queue the request' } }));
      onToast('Could not send the link', 'error');
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <h3 className="font-semibold text-slate-900 mb-1">Send a link</h3>
      <p className="text-xs text-slate-500 mb-3">These steps stay with the person. Evia texts the link to their phone, the same one she sends on her own.</p>
      <div className="space-y-2">
        {LINKS[role].map(({ kind, label }) => {
          const o = outcomes[kind] ?? {};
          return (
            <div key={kind} className="flex items-center justify-between gap-3">
              <span className="text-sm text-slate-700">{label}</span>
              <div className="flex items-center gap-2">
                {o.sentAt && <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle className="w-3.5 h-3.5" /> Sent {new Date(o.sentAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>}
                {o.error && <span className="inline-flex items-center gap-1 text-xs text-red-700 max-w-xs text-right"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> {o.error}</span>}
                <button onClick={() => send(kind)} disabled={!!o.sending}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  {o.sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Send
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AdminSendLinks;
