import React, { useState } from 'react';
import { AlertTriangle, Check, Loader2, ShieldCheck } from 'lucide-react';
import { adminService } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

// Name review (2026-10-24) — shown on a person's admin page when their background
// check (care provider) or ID check (client) cleared under a legal name that
// doesn't match the account name. The approval is on hold until the team decides:
// "Use the verified name" (the profile name becomes the legal name, locked) or
// "Keep the account name" (with a reason). Either way the person is texted and
// the held approval is applied exactly as the webhook would have.

export interface NameReviewData {
  status: 'mismatch' | 'resolved';
  source: 'checkr' | 'stripe_identity';
  accountName: string;
  verifiedFirst: string;
  verifiedLast: string;
  at: string;
  resolvedAt?: string;
  resolvedBy?: { uid: string; name: string };
  decision?: 'use_verified' | 'keep_account';
  reason?: string;
}

interface Props {
  uid: string;
  role: 'client' | 'caregiver';
  review?: NameReviewData | null;
  nameLocked?: boolean;
  verifiedLegalName?: string;
  onToast: (msg: string, type: 'success' | 'error') => void;
  onResolved?: () => void;
}

const fmt = (iso?: string) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

export const NameReviewCard: React.FC<Props> = ({ uid, role, review, nameLocked, verifiedLegalName, onToast, onResolved }) => {
  const { currentUser: ctxUser, adminUser } = useCareConnex();
  const me = adminUser ?? ctxUser;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'use_verified' | 'keep_account' | null>(null);

  if (!review || review.status !== 'mismatch') {
    if (nameLocked && verifiedLegalName) {
      return (
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3 text-sm">
          <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="text-slate-700">Name on file matches the verified ID: <strong>{verifiedLegalName}</strong>. Locked — only the team can change it.</span>
          {review?.decision === 'keep_account' && <span className="text-xs text-slate-500">Account name kept by {review.resolvedBy?.name} ({review.reason})</span>}
        </div>
      );
    }
    return null;
  }

  const verified = [review.verifiedFirst, review.verifiedLast].filter(Boolean).join(' ');
  const check = review.source === 'checkr' ? 'background check' : 'ID check';

  const decide = async (decision: 'use_verified' | 'keep_account') => {
    if (!me) { onToast('Not signed in as an admin', 'error'); return; }
    if (decision === 'keep_account' && !reason.trim()) { onToast('Add a short reason to keep the account name', 'error'); return; }
    setBusy(decision);
    try {
      const id = await adminService.queueAdminAssist({
        type: decision === 'use_verified' ? 'name_use_verified' : 'name_keep_account', uid, role,
        reason: reason.trim() || undefined,
        adminUid: me.uid, adminName: me.displayName || me.email || me.uid,
      });
      adminService.watchAdminAssistRequest(id, ({ error }) => {
        setBusy(null);
        if (error) { onToast(error, 'error'); return; }
        onToast(decision === 'use_verified' ? `Name set to ${verified} and approved` : 'Account name kept and approved', 'success');
        onResolved?.();
      });
    } catch {
      setBusy(null);
      onToast('Could not send the decision', 'error');
    }
  };

  return (
    <div className="bg-amber-50 rounded-xl border border-amber-200 p-5 space-y-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold text-amber-900">Name doesn't match the {check} — approval on hold</h3>
          <p className="text-sm text-amber-800 mt-1">The {check} cleared on {fmt(review.at)}, but the names differ. Nothing goes live until you decide.</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-white rounded-lg border border-amber-200 p-3">
          <p className="text-xs text-slate-500 mb-1">On the account</p>
          <p className="font-semibold text-slate-900">{review.accountName || <span className="text-slate-400">no name</span>}</p>
        </div>
        <div className="bg-white rounded-lg border border-amber-200 p-3">
          <p className="text-xs text-slate-500 mb-1">Verified by the {check}</p>
          <p className="font-semibold text-slate-900">{verified}</p>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <button onClick={() => decide('use_verified')} disabled={!!busy}
          className="inline-flex items-center justify-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
          {busy === 'use_verified' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Use the verified name ({verified})
        </button>
        <div className="flex-1 flex items-end gap-2">
          <label className="flex-1 text-xs text-slate-600">
            Keep the account name — reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. maiden name on the ID, confirmed by phone"
              className="mt-1 w-full text-sm rounded-lg border border-amber-300 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-300" />
          </label>
          <button onClick={() => decide('keep_account')} disabled={!!busy || !reason.trim()}
            className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border border-amber-300 bg-white text-amber-900 hover:bg-amber-100 disabled:opacity-50">
            {busy === 'keep_account' ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Keep account name
          </button>
        </div>
      </div>
      <p className="text-xs text-amber-800">Either way the person is texted, the name is locked afterwards, and the held approval is applied.</p>
    </div>
  );
};

export default NameReviewCard;
