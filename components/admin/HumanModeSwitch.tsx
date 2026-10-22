import React, { useEffect, useState } from 'react';
import { UserRound, Bot, Loader2 } from 'lucide-react';
import { adminService, type HumanModeFields } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

// Human mode switch (2026-10-22) — on the admin client / care provider pages.
// "Hand to human" turns the person's flag on: Evia stops replying to them, their
// texts land in the Messages tab with an alert, and the team answers from there.
// "Back to Evia" turns it off. Evia's own handoffs flip the same flag.

interface Props {
  uid: string;
  role: 'client' | 'caregiver';
  personName: string;
  onToast: (msg: string, type: 'success' | 'error') => void;
}

const fmt = (iso?: string) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const REASONS: Record<string, string> = { admin: 'by the team', low_confidence: "Evia wasn't sure enough to answer", asked_for_human: 'they asked for a person' };

export const HumanModeSwitch: React.FC<Props> = ({ uid, role, personName, onToast }) => {
  const { currentUser: ctxUser, adminUser } = useCareConnex();
  const currentUser = adminUser ?? ctxUser;
  const [fields, setFields] = useState<HumanModeFields | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setFields(null); return adminService.watchHumanMode(uid, setFields); }, [uid]);

  const on = fields?.humanModeOn === true;
  const first = personName.split(/\s+/)[0] || 'this person';

  const flip = async (next: boolean) => {
    if (!currentUser) { onToast('Not signed in as an admin', 'error'); return; }
    setBusy(true);
    try {
      const id = await adminService.queueAdminAssist({
        type: next ? 'human_on' : 'human_off', uid, role,
        adminUid: currentUser.uid, adminName: currentUser.displayName || currentUser.email || currentUser.uid,
      });
      adminService.watchAdminAssistRequest(id, ({ error }) => {
        setBusy(false);
        if (error) onToast(error, 'error');
        else onToast(next ? `Evia is quiet for ${first} — reply from the Messages tab` : `Evia is replying to ${first} again`, 'success');
      });
    } catch {
      setBusy(false);
      onToast('Could not change human mode', 'error');
    }
  };

  return (
    <div className={`px-5 py-2.5 border-b text-sm flex items-center gap-3 flex-wrap ${on ? 'bg-rose-50 border-rose-200' : 'bg-white border-slate-200'}`}>
      {on ? (
        <>
          <UserRound className="w-4 h-4 text-rose-600 shrink-0" />
          <span className="text-rose-900">
            <strong>Human mode</strong> since {fmt(fields?.humanModeSince)}{fields?.humanModeByName ? ` · ${fields.humanModeByName}` : ''}{fields?.humanModeReason ? ` · ${REASONS[fields.humanModeReason] ?? fields.humanModeReason}` : ''}
            {typeof fields?.humanModeUnread === 'number' && fields.humanModeUnread > 0 && <span className="ml-2 text-xs font-semibold px-1.5 py-0.5 rounded-full bg-rose-600 text-white">{fields.humanModeUnread} unanswered</span>}
          </span>
          <span className="text-xs text-rose-700 hidden md:inline">Evia is not replying to {first}. Answer from the Messages tab.</span>
          <button onClick={() => flip(false)} disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border border-rose-300 bg-white text-rose-800 hover:bg-rose-100 disabled:opacity-50">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bot className="w-3 h-3" />} Back to Evia
          </button>
        </>
      ) : (
        <>
          <Bot className="w-4 h-4 text-slate-500 shrink-0" />
          <span className="text-slate-700">Evia is replying to {first}.{fields?.humanModeEndedAt ? ` Last human session ended ${fmt(fields.humanModeEndedAt)}.` : ''}</span>
          <button onClick={() => flip(true)} disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserRound className="w-3 h-3" />} Hand to human
          </button>
        </>
      )}
    </div>
  );
};

export default HumanModeSwitch;
