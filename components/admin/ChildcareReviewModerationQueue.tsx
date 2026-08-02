import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronLeft, ChevronRight, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { auth } from '../../lib/firebase';
import {
  adminService,
  type ChildcareReviewModerationDecision,
  type ChildcareReviewModerationRow,
} from '../../services/api';

const REASONS: Record<ChildcareReviewModerationDecision, Array<{ value: string; label: string }>> = {
  published: [{ value: 'approve_safe', label: 'Safe to publish' }],
  rejected: [
    { value: 'reject_child_pii', label: 'Contains personal child information' },
    { value: 'reject_abuse', label: 'Abusive or threatening' },
    { value: 'reject_irrelevant', label: 'Not relevant to the booking' },
  ],
  unpublished: [{ value: 'unpublish_policy', label: 'Policy removal' }],
  deleted: [{ value: 'delete_retention', label: 'Retention deletion' }],
};

function isRecentAuthError(error: unknown): boolean {
  const value = error as { code?: string; details?: { code?: string } };
  return value?.details?.code === 'recent_auth_required';
}

function isStaleDecision(error: unknown): boolean {
  const value = error as { code?: string; details?: { code?: string } };
  return value?.details?.code === 'stale_review_version' ||
    String(value?.code ?? '').includes('aborted');
}

export const ChildcareReviewModerationQueue: React.FC = () => {
  const [rows, setRows] = useState<ChildcareReviewModerationRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsRecentAuth, setNeedsRecentAuth] = useState(false);
  const [selected, setSelected] = useState<ChildcareReviewModerationRow | null>(null);
  const [decision, setDecision] = useState<ChildcareReviewModerationDecision>('published');
  const [reasonCode, setReasonCode] = useState('approve_safe');
  const [publicComment, setPublicComment] = useState('');
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async (pageCursor: string | null = cursor) => {
    setLoading(true);
    setError(null);
    setNeedsRecentAuth(false);
    try {
      const page = await adminService.listChildcareReviewModerationQueue(pageCursor);
      setRows(page.rows);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setNeedsRecentAuth(isRecentAuthError(err));
      setError('The childcare review queue could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [cursor]);

  useEffect(() => {
    void load(cursor);
  }, [cursor, load]);

  useEffect(() => {
    if (!auth) return;
    let initialUid = auth.currentUser?.uid ?? null;
    return auth.onAuthStateChanged((user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid !== initialUid) {
        initialUid = nextUid;
        setRows([]);
        setSelected(null);
        setPublicComment('');
        setReasonCode('approve_safe');
        setCursor(null);
        setHistory([]);
        void load(null);
      }
    });
  }, [load]);

  const openDecision = (row: ChildcareReviewModerationRow, nextDecision: ChildcareReviewModerationDecision) => {
    setSelected(row);
    setDecision(nextDecision);
    setReasonCode(REASONS[nextDecision][0].value);
    setPublicComment(nextDecision === 'published' ? row.comment : '');
    setError(null);
  };

  const submitDecision = async () => {
    if (!selected || !reasonCode) return;
    setProcessing(true);
    setError(null);
    try {
      await adminService.moderateChildcareReview({
        reviewId: selected.reviewId,
        expectedVersion: selected.stateVersion,
        decision,
        reasonCode,
        ...(decision === 'published' ? { publicComment } : {}),
      });
      setRows(current => current.filter(row => row.reviewId !== selected.reviewId));
      setSelected(null);
      setPublicComment('');
    } catch (err) {
      if (isStaleDecision(err)) {
        await load(cursor);
        setError('This review changed in another session. The queue was refreshed.');
      } else {
        setNeedsRecentAuth(isRecentAuthError(err));
        setError('The moderation decision was not saved.');
      }
    } finally {
      setProcessing(false);
    }
  };

  const pageLabel = useMemo(() => history.length + 1, [history.length]);

  return (
    <section className="border-b border-slate-200 pb-8 mb-8" aria-labelledby="childcare-review-heading">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 id="childcare-review-heading" className="text-lg font-semibold text-slate-900">Childcare review moderation</h2>
          <p className="text-sm text-slate-500">Private submissions awaiting publication review</p>
        </div>
        <button
          type="button"
          title="Refresh queue"
          aria-label="Refresh queue"
          onClick={() => void load(cursor)}
          className="p-2 border border-slate-300 rounded-md text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 mb-3 rounded-md">
          <span className="flex items-center gap-2"><AlertCircle size={16} />{error}</span>
          {needsRecentAuth && (
            <button
              type="button"
              onClick={() => window.location.assign('/login?reauth=childcare-review-moderation')}
              className="font-medium underline"
            >
              Reauthenticate
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-slate-500">Loading review queue...</div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center border border-dashed border-slate-300 rounded-md">
          <ShieldAlert size={22} className="mx-auto mb-2 text-slate-400" />
          <p className="text-sm text-slate-600">No childcare reviews are waiting.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-200 border-y border-slate-200">
          {rows.map(row => (
            <article key={row.reviewId} className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900">
                    {row.rating}/5 · {row.reviewerRole}
                  </div>
                  <div className="text-xs text-slate-500">{new Date(row.createdAt).toLocaleString()}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => openDecision(row, 'published')}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-700 text-white rounded-md hover:bg-emerald-800"
                  >
                    <Check size={16} /> Publish
                  </button>
                  <button
                    type="button"
                    onClick={() => openDecision(row, 'rejected')}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50"
                  >
                    <X size={16} /> Reject
                  </button>
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{row.comment || 'No written comment.'}</p>
            </article>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mt-4">
        <span className="text-xs text-slate-500">Page {pageLabel}</span>
        <div className="flex gap-2">
          <button
            type="button"
            title="Previous page"
            aria-label="Previous page"
            disabled={history.length === 0 || loading}
            onClick={() => {
              const previous = history[history.length - 1] ?? null;
              setHistory(value => value.slice(0, -1));
              setCursor(previous);
            }}
            className="p-2 border border-slate-300 rounded-md disabled:opacity-40"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            title="Next page"
            aria-label="Next page"
            disabled={!nextCursor || loading}
            onClick={() => {
              setHistory(value => [...value, cursor]);
              setCursor(nextCursor);
            }}
            className="p-2 border border-slate-300 rounded-md disabled:opacity-40"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg bg-white rounded-md shadow-xl p-5">
            <h3 className="text-base font-semibold text-slate-900">
              {decision === 'published' ? 'Publish childcare review' : 'Reject childcare review'}
            </h3>
            {decision === 'published' && (
              <label className="block mt-4 text-sm font-medium text-slate-700">
                Public comment
                <textarea
                  value={publicComment}
                  onChange={event => setPublicComment(event.target.value)}
                  rows={5}
                  maxLength={1200}
                  className="mt-1 w-full border border-slate-300 rounded-md p-2 text-sm"
                />
              </label>
            )}
            <label className="block mt-4 text-sm font-medium text-slate-700">
              Reason
              <select
                value={reasonCode}
                onChange={event => setReasonCode(event.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-md p-2 text-sm"
              >
                {REASONS[decision].map(reason => (
                  <option key={reason.value} value={reason.value}>{reason.label}</option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                disabled={processing}
                onClick={() => setSelected(null)}
                className="px-3 py-2 text-sm border border-slate-300 rounded-md"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={processing || (decision === 'published' && !publicComment.trim())}
                onClick={() => void submitDecision()}
                className="px-3 py-2 text-sm font-medium bg-slate-900 text-white rounded-md disabled:opacity-50"
              >
                {processing ? 'Saving...' : 'Confirm decision'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
