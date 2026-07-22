import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles, Check, X, AlertTriangle, Send, Clock, MessageCircle,
  RefreshCw, Search, Pencil,
} from 'lucide-react';
import { authService, dbService } from '../../services/api';

// ── Types ────────────────────────────────────────────────────────────────────

type ProactiveDraftStatus =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'sent'
  | 'send_failed'
  | 'expired';

interface ProactiveDraft {
  id:            string;
  userId:        string;
  phone:         string;
  draftText:     string;
  reason:        string;
  severity:      'low' | 'medium' | 'high';
  contextHash:   string;
  status:        ProactiveDraftStatus;
  createdAt:     string;
  inputs?: {
    journalCount:  number;
    pastApptCount: number;
    upcomingCount: number;
    billingCount:  number;
  };
  approvedAt?:      string;
  approvedBy?:      string;
  approvalNote?:    string;
  rejectedAt?:      string;
  rejectedBy?:      string;
  rejectionReason?: string;
  editedAt?:        string;
  editedBy?:        string;
  sentAt?:          string;
  sendError?:       string;
  lastAttemptAt?:   string;
  expiredAt?:       string;
}

interface Props {
  onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

// ── Filter buckets ──────────────────────────────────────────────────────────

type FilterKey = 'pending' | 'approved' | 'rejected' | 'sent' | 'failed' | 'all';

const FILTER_TO_STATUSES: Record<FilterKey, ProactiveDraftStatus[]> = {
  pending:  ['pending_review'],
  approved: ['approved'],
  rejected: ['rejected'],
  sent:     ['sent'],
  failed:   ['send_failed', 'expired'],
  all:      [], // empty = no filter
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRelative(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diffMin = Math.round((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function maskPhone(phone: string): string {
  if (!phone) return '';
  // Show country + last 4 — middle masked. e.g. +1•••••6789
  if (phone.length >= 6) return `${phone.slice(0, 2)}•••••${phone.slice(-4)}`;
  return '••••';
}

const SeverityBadge: React.FC<{ severity: ProactiveDraft['severity'] }> = ({ severity }) => {
  const styles = {
    high:   'bg-red-50 text-red-700 border-red-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    low:    'bg-slate-50 text-slate-600 border-slate-200',
  } as const;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${styles[severity]}`}>
      {severity}
    </span>
  );
};

const StatusBadge: React.FC<{ status: ProactiveDraftStatus }> = ({ status }) => {
  const styles: Record<ProactiveDraftStatus, string> = {
    pending_review: 'bg-blue-50 text-blue-700 border-blue-200',
    approved:       'bg-emerald-50 text-emerald-700 border-emerald-200',
    rejected:       'bg-slate-100 text-slate-600 border-slate-200',
    sent:           'bg-teal-50 text-teal-700 border-teal-200',
    send_failed:    'bg-red-50 text-red-700 border-red-200',
    expired:        'bg-slate-50 text-slate-500 border-slate-200',
  };
  const label = status.replace('_', ' ');
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${styles[status]}`}>
      {label}
    </span>
  );
};

// ── Component ───────────────────────────────────────────────────────────────

export const ProactiveReflectionDashboard: React.FC<Props> = ({ onShowToast }) => {
  const [drafts, setDrafts] = useState<ProactiveDraft[]>([]);
  const [filter, setFilter] = useState<FilterKey>('pending');
  const [selected, setSelected] = useState<ProactiveDraft | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editedText, setEditedText] = useState('');

  const adminUid = authService.getCurrentUser()?.uid ?? '';

  // Live subscription per filter.
  useEffect(() => {
    const unsub = dbService.subscribeProactiveDrafts(
      FILTER_TO_STATUSES[filter],
      (rows) => setDrafts(rows as ProactiveDraft[]),
    );
    return unsub;
  }, [filter]);

  // When the selected draft changes, sync the local edit/note state.
  useEffect(() => {
    setReviewNote('');
    setRejectionReason('');
    setEditMode(false);
    setEditedText(selected?.draftText ?? '');
  }, [selected?.id]);

  const filtered = useMemo(() => {
    if (!search.trim()) return drafts;
    const needle = search.trim().toLowerCase();
    return drafts.filter((d) =>
      d.draftText?.toLowerCase().includes(needle) ||
      d.reason?.toLowerCase().includes(needle) ||
      d.phone?.includes(needle.replace(/\D/g, '')),
    );
  }, [drafts, search]);

  const counts = useMemo(() => ({
    showing: filtered.length,
    total:   drafts.length,
  }), [filtered.length, drafts.length]);

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleApprove(d: ProactiveDraft) {
    if (busy) return;
    setBusy(true);
    try {
      // Inline edits ride the approve callable itself (U8/AE23) so the
      // server's reviewed-content hash covers the FINAL text.
      const edited = editMode && editedText.trim() && editedText.trim() !== d.draftText
        ? editedText
        : undefined;
      await dbService.approveProactiveDraft(d.id, adminUid, reviewNote, edited);
      onShowToast('Draft approved — queued for send', 'success');
      setSelected(null);
    } catch (err) {
      console.error('approve failed:', err);
      onShowToast('Approve failed — see console', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(d: ProactiveDraft) {
    if (busy) return;
    if (!rejectionReason.trim()) {
      onShowToast('Add a rejection reason first', 'error');
      return;
    }
    setBusy(true);
    try {
      await dbService.rejectProactiveDraft(d.id, adminUid, rejectionReason);
      onShowToast('Draft rejected', 'info');
      setSelected(null);
    } catch (err) {
      console.error('reject failed:', err);
      onShowToast('Reject failed — see console', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleSendNow(d: ProactiveDraft) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await dbService.sendApprovedDraftNow(d.id);
      if (result.success) {
        onShowToast('Sent', 'success');
        setSelected(null);
      } else {
        onShowToast(`Send failed: ${result.error ?? 'unknown'}`, 'error');
      }
    } catch (err) {
      console.error('send-now failed:', err);
      onShowToast('Send call failed — see console', 'error');
    } finally {
      setBusy(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full bg-slate-50">
      {/* ── List ───────────────────────────────────────────────────────────── */}
      <div className="w-[420px] border-r border-slate-200 bg-white flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-5 h-5 text-primary-600" />
            <h2 className="text-base font-semibold text-slate-900">Proactive drafts</h2>
            <span className="ml-auto text-xs text-slate-400">{counts.showing}/{counts.total}</span>
          </div>

          {/* Filter chips */}
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(FILTER_TO_STATUSES) as FilterKey[]).map((k) => (
              <button
                key={k}
                onClick={() => { setFilter(k); setSelected(null); }}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  filter === k
                    ? 'bg-primary-600 text-white border-primary-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="mt-3 relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="Search text / reason / phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-200"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              No drafts match this filter.
            </div>
          ) : (
            filtered.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelected(d)}
                className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors ${
                  selected?.id === d.id ? 'bg-primary-50/40' : ''
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <SeverityBadge severity={d.severity} />
                  <span className="text-xs text-slate-400">{formatRelative(d.createdAt)}</span>
                </div>
                <p className="text-sm text-slate-700 line-clamp-2 mb-1.5">{d.draftText}</p>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="font-mono">{maskPhone(d.phone)}</span>
                  <StatusBadge status={d.status} />
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Detail ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            <div className="text-center">
              <Sparkles className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              <p>Select a draft to review.</p>
            </div>
          </div>
        ) : (
          <div className="p-8 max-w-3xl mx-auto">
            {/* Header */}
            <div className="flex items-center gap-3 mb-1">
              <SeverityBadge severity={selected.severity} />
              <StatusBadge status={selected.status} />
              <span className="ml-auto text-xs text-slate-400 flex items-center gap-1">
                <Clock className="w-3 h-3" /> {formatRelative(selected.createdAt)}
              </span>
            </div>
            <h3 className="text-xl font-semibold text-slate-900 mb-4">Evia's proposed message</h3>

            {/* Draft text — editable in edit mode */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">SMS body</span>
                {!editMode && selected.status === 'pending_review' && (
                  <button
                    onClick={() => setEditMode(true)}
                    className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-1"
                  >
                    <Pencil className="w-3 h-3" /> Edit before approving
                  </button>
                )}
              </div>
              {editMode ? (
                <textarea
                  value={editedText}
                  onChange={(e) => setEditedText(e.target.value)}
                  rows={4}
                  maxLength={320}
                  className="w-full p-3 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-200 font-normal text-slate-800"
                />
              ) : (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg whitespace-pre-wrap text-slate-800">
                  {selected.draftText}
                </div>
              )}
              <p className="text-xs text-slate-400 mt-1.5">
                Will be sent to <span className="font-mono">{maskPhone(selected.phone)}</span>
                {selected.editedAt && ` · last edited ${formatRelative(selected.editedAt)}`}
              </p>
            </div>

            {/* Why Evia surfaced this */}
            <div className="mb-6">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Why surfaced</div>
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-sm text-slate-700 flex items-start gap-2">
                <MessageCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                <span>{selected.reason}</span>
              </div>
            </div>

            {/* Input snapshot */}
            {selected.inputs && (
              <div className="mb-6">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Inputs in the 24h window</div>
                <div className="grid grid-cols-4 gap-2">
                  <InputStat label="Journal" value={selected.inputs.journalCount} />
                  <InputStat label="Past visits" value={selected.inputs.pastApptCount} />
                  <InputStat label="Upcoming" value={selected.inputs.upcomingCount} />
                  <InputStat label="Billing" value={selected.inputs.billingCount} />
                </div>
              </div>
            )}

            {/* Audit metadata for non-pending drafts */}
            {selected.status !== 'pending_review' && (
              <div className="mb-6 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-500 space-y-1">
                {selected.approvedAt && <div>Approved {formatRelative(selected.approvedAt)} by {selected.approvedBy ?? 'admin'}{selected.approvalNote ? ` — "${selected.approvalNote}"` : ''}</div>}
                {selected.rejectedAt && <div>Rejected {formatRelative(selected.rejectedAt)} by {selected.rejectedBy ?? 'admin'} — "{selected.rejectionReason ?? '(no reason)'}"</div>}
                {selected.sentAt     && <div>Sent {formatRelative(selected.sentAt)}</div>}
                {selected.expiredAt  && <div className="text-amber-600">Expired {formatRelative(selected.expiredAt)} (was older than 24h when the sender ran)</div>}
                {selected.sendError  && <div className="text-red-600 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /><span>Send failed: {selected.sendError}</span></div>}
              </div>
            )}

            {/* ── Actions ─────────────────────────────────────────────────── */}
            {selected.status === 'pending_review' && (
              <>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                    Approval note (optional)
                  </label>
                  <input
                    type="text"
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    placeholder="e.g. 'good — gentle tone'"
                    className="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-200"
                  />
                </div>
                <div className="mb-6">
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                    Rejection reason (required to reject)
                  </label>
                  <input
                    type="text"
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    placeholder="e.g. 'too soon to surface'"
                    className="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-200"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleApprove(selected)}
                    disabled={busy}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                  >
                    <Check className="w-4 h-4" /> Approve {editMode ? '(with edits)' : ''}
                  </button>
                  <button
                    onClick={() => handleReject(selected)}
                    disabled={busy}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-white border border-slate-300 text-slate-700 text-sm font-semibold rounded-lg hover:bg-slate-50 disabled:opacity-50"
                  >
                    <X className="w-4 h-4" /> Reject
                  </button>
                </div>
              </>
            )}

            {selected.status === 'approved' && (
              <button
                onClick={() => handleSendNow(selected)}
                disabled={busy}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                <Send className="w-4 h-4" /> Send now (skips the 5-min cron)
              </button>
            )}

            {selected.status === 'send_failed' && (
              <button
                onClick={() => handleSendNow(selected)}
                disabled={busy}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700 disabled:opacity-50"
              >
                <RefreshCw className="w-4 h-4" /> Retry send
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const InputStat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="p-3 bg-white border border-slate-200 rounded-lg">
    <div className="text-2xl font-semibold text-slate-900">{value}</div>
    <div className="text-xs text-slate-500">{label}</div>
  </div>
);

export default ProactiveReflectionDashboard;
