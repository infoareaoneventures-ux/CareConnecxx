// ── Childcare incident queue (plan 2026-07-22-002, U12 / R55-R56, AE18) ──────
//
// Operator surface for the restricted childcare incident cases. STRUCTURAL
// CONTRACTS:
//   • NO direct Firestore access — childcare_incidents is rules-denied in the
//     browser even for admins. The queue is the SANITIZED projection from
//     v1-listChildcareIncidents (category/status/timestamps/counts only; no
//     child details, no phone, no booking ids).
//   • Case DETAIL requires the childSafetyOperator scope AND a typed
//     reason-for-access (R56): the reason prompt renders BEFORE any detail
//     fetch, and the reason travels to v1-getChildcareIncidentDetail where it
//     is immutably audited server-side. No reason, no request.
//   • Status changes / assignment go through the operator callables; the
//     valid next statuses come from the case's current status (the server
//     enforces the deterministic transition map either way).
//   • Works during emergency-off — the incident callables are never dark.
//
// Plain functional UI in the existing admin-component idiom (AuditTrail.tsx
// state/loading patterns; ChildProfileFlow.tsx callable idiom).

import React, { useCallback, useEffect, useState } from 'react';
import { auth, functions } from '../../lib/firebase';
import { childcareCallable } from '../../lib/childcareCallable';

interface IncidentQueueRow {
  caseId: string;
  category: string;
  status: string;
  source: string;
  ownerUid: string | null;
  createdAt: string;
  updatedAt: string;
  evidenceCount: number;
  suspectedPartyCount: number;
  hasPayoutHold: boolean;
  hasLitigationHold: boolean;
}

interface IncidentDetail extends Record<string, unknown> {
  caseId: string;
  category: string;
  status: string;
  ownerUid: string | null;
  summary: string | null;
  subject: { bookingId: string | null; sessionPhone: string | null; householdId: string | null };
  evidenceRefs: Array<{ kind: string; ref: string; addedByUid: string; addedAt: string }>;
  suspectedPartyUids: string[];
  transitions: Array<{ from: string; to: string; byUid: string; at: string; note: string | null }>;
}

// Mirror of the server's deterministic transition map (display only — the
// server re-validates every move).
const NEXT_STATUSES: Record<string, string[]> = {
  open: ['investigating'],
  investigating: ['resolved', 'escalated'],
  escalated: ['investigating', 'resolved'],
  resolved: ['appealed'],
  appealed: ['resolved', 'corrected'],
  corrected: [],
};

const STATUS_FILTERS = ['', 'open', 'investigating', 'escalated', 'resolved', 'appealed', 'corrected'];

function errCode(err: unknown): string {
  return String((err as { code?: string })?.code ?? '');
}

function fmt(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export const ChildcareIncidentQueue: React.FC = () => {
  const [rows, setRows] = useState<IncidentQueueRow[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reason-for-access gate (R56): selecting a case opens the prompt; the
  // detail fetch happens ONLY after a non-empty reason is submitted.
  const [pendingCaseId, setPendingCaseId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!functions) { setError('Functions unavailable.'); return; }
    setLoading(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (statusFilter) payload.status = statusFilter;
      const res = await childcareCallable('listChildcareIncidents')(payload);
      const data = res.data as { incidents?: IncidentQueueRow[] };
      setRows(data?.incidents ?? []);
    } catch (err) {
      setError(
        errCode(err) === 'permission-denied'
          ? 'You do not have an operator role for the childcare incident queue.'
          : 'Could not load the incident queue.',
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { void refresh(); }, [refresh]);

  const openReasonPrompt = (caseId: string) => {
    setPendingCaseId(caseId);
    setReason('');
    setDetail(null);
    setDetailError(null);
  };

  const fetchDetail = async () => {
    if (!functions || !pendingCaseId) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setDetailError('A reason for access is required.');
      return;
    }
    setDetailBusy(true);
    setDetailError(null);
    try {
      const res = await childcareCallable('getChildcareIncidentDetail')({
        caseId: pendingCaseId,
        reason: trimmed,
      });
      const data = res.data as { incident?: IncidentDetail };
      setDetail(data?.incident ?? null);
    } catch (err) {
      const code = errCode(err);
      setDetailError(
        code === 'permission-denied'
          ? 'Case detail requires the child-safety operator role.'
          : code === 'failed-precondition'
            ? 'This action needs a recent sign-in and a reason for access.'
            : 'Could not load the case.',
      );
    } finally {
      setDetailBusy(false);
    }
  };

  const closeDetail = () => {
    setPendingCaseId(null);
    setReason('');
    setDetail(null);
    setDetailError(null);
  };

  const changeStatus = async (to: string) => {
    if (!functions || !detail) return;
    setDetailBusy(true);
    setDetailError(null);
    try {
      await childcareCallable('updateChildcareIncidentStatus')({
        caseId: detail.caseId,
        status: to,
        reason,
      });
      setDetail({ ...detail, status: to });
      await refresh();
    } catch {
      setDetailError('The status change was not allowed.');
    } finally {
      setDetailBusy(false);
    }
  };

  const assignToMe = async () => {
    if (!functions || !detail) return;
    const myUid = auth?.currentUser?.uid;
    if (!myUid) {
      setDetailError('Could not assign the case.');
      return;
    }
    setDetailBusy(true);
    setDetailError(null);
    try {
      const res = await childcareCallable('assignChildcareIncident')({
        caseId: detail.caseId,
        ownerUid: myUid,
        reason,
      });
      const data = res.data as { ownerUid?: string };
      setDetail({ ...detail, ownerUid: data?.ownerUid ?? myUid });
      await refresh();
    } catch {
      setDetailError('Could not assign the case.');
    } finally {
      setDetailBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Childcare Incident Queue</h2>
        <div className="flex items-center gap-2">
          <label htmlFor="incident-status-filter" className="text-sm">Status</label>
          <select
            id="incident-status-filter"
            className="border rounded px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s || 'all'} value={s}>{s || 'All statuses'}</option>
            ))}
          </select>
          <button className="border rounded px-3 py-1 text-sm" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div role="alert" className="text-red-600 text-sm">{error}</div>}
      {loading && <div className="text-sm text-gray-500">Loading…</div>}

      {!loading && rows.length === 0 && !error && (
        <div className="text-sm text-gray-500">No incident cases.</div>
      )}

      {rows.length > 0 && (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-2">Category</th>
              <th className="py-2 pr-2">Status</th>
              <th className="py-2 pr-2">Source</th>
              <th className="py-2 pr-2">Owner</th>
              <th className="py-2 pr-2">Opened</th>
              <th className="py-2 pr-2">Holds</th>
              <th className="py-2 pr-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.caseId} className="border-b">
                <td className="py-2 pr-2 font-medium">{row.category}</td>
                <td className="py-2 pr-2">{row.status}</td>
                <td className="py-2 pr-2">{row.source === 'marker' ? 'escalation' : 'report'}</td>
                <td className="py-2 pr-2">{row.ownerUid ?? 'unassigned'}</td>
                <td className="py-2 pr-2">{fmt(row.createdAt)}</td>
                <td className="py-2 pr-2">
                  {[row.hasPayoutHold ? 'payout' : null, row.hasLitigationHold ? 'litigation' : null]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </td>
                <td className="py-2 pr-2">
                  <button
                    className="border rounded px-2 py-1 text-xs"
                    onClick={() => openReasonPrompt(row.caseId)}
                  >
                    Open case
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingCaseId && !detail && (
        <div className="border rounded p-4 space-y-2 max-w-lg">
          <h3 className="font-semibold text-sm">Reason for access</h3>
          <p className="text-xs text-gray-600">
            Case detail contains restricted child-safety information. Your reason is
            recorded in the immutable audit log with your identity and a timestamp.
          </p>
          <select
            aria-label="Reason for access"
            className="w-full border rounded p-2 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">Select a reason</option>
            <option value="incident_triage">Incident triage</option>
            <option value="incident_investigation">Incident investigation</option>
            <option value="safety_review">Child safety review</option>
          </select>
          {detailError && <div role="alert" className="text-red-600 text-xs">{detailError}</div>}
          <div className="flex gap-2">
            <button
              className="border rounded px-3 py-1 text-sm"
              disabled={detailBusy}
              onClick={() => void fetchDetail()}
            >
              Open case detail
            </button>
            <button className="border rounded px-3 py-1 text-sm" onClick={closeDetail}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {detail && (
        <div className="border rounded p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">
              Case {detail.caseId} — {detail.category} ({detail.status})
            </h3>
            <button className="border rounded px-2 py-1 text-xs" onClick={closeDetail}>
              Close
            </button>
          </div>
          {detail.summary && <p className="text-sm">{detail.summary}</p>}
          <div className="text-xs text-gray-600">
            Owner: {detail.ownerUid ?? 'unassigned'} · Booking: {detail.subject.bookingId ?? '—'} ·
            Session: {detail.subject.sessionPhone ?? '—'}
          </div>
          <div className="text-xs">
            Suspected parties excluded from notifications: {detail.suspectedPartyUids.length}
          </div>
          <div>
            <h4 className="text-xs font-semibold mt-2">Evidence references</h4>
            <ul className="text-xs list-disc ml-4">
              {detail.evidenceRefs.map((e, i) => (
                <li key={i}>{e.kind}: {e.ref}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold mt-2">History</h4>
            <ul className="text-xs list-disc ml-4">
              {detail.transitions.map((t, i) => (
                <li key={i}>{t.from} → {t.to} by {t.byUid} at {fmt(t.at)}{t.note ? ` — ${t.note}` : ''}</li>
              ))}
              {detail.transitions.length === 0 && <li>opened</li>}
            </ul>
          </div>
          {detailError && <div role="alert" className="text-red-600 text-xs">{detailError}</div>}
          <div className="flex gap-2 flex-wrap">
            {(NEXT_STATUSES[detail.status] ?? []).map((to) => (
              <button
                key={to}
                className="border rounded px-3 py-1 text-sm"
                disabled={detailBusy}
                onClick={() => void changeStatus(to)}
              >
                Mark {to}
              </button>
            ))}
            <button
              className="border rounded px-3 py-1 text-sm"
              disabled={detailBusy}
              onClick={() => void assignToMe()}
            >
              Assign to me
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChildcareIncidentQueue;
