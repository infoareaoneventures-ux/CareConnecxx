import React, { useState, useEffect, useCallback } from 'react';
import { Search, Filter, ChevronLeft, ChevronRight, AlertTriangle } from 'lucide-react';
import { db } from '../../lib/firebase';
import {
  collection, query, orderBy, limit, startAfter,
  where, getDocs, QueryDocumentSnapshot, DocumentData, Timestamp,
} from 'firebase/firestore';

const PAGE_SIZE = 50;

type AuditEventType =
  | 'message_sent' | 'message_received' | 'health_data_accessed'
  | 'booking_created' | 'booking_cancelled' | 'caregiver_matched'
  | 'permissions_updated' | 'crisis_detected' | 'payment_processed'
  | 'background_check_requested' | 'background_check_result'
  | 'profile_updated' | 'login' | 'logout' | 'admin_action'
  | 'intake_submitted' | 'caregiver_approved' | 'caregiver_suspended'
  | 'shift_checkin' | 'emergency_triggered' | 'wellbeing_checkin'
  | 'ai_proxy_called' | 'rate_limit_hit';

interface AuditEntry {
  id: string;
  eventType: AuditEventType | string;
  userId?: string;
  phone?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

function parseTimestamp(raw: unknown): string {
  if (!raw) return '—';
  if (raw instanceof Timestamp) return raw.toDate().toISOString();
  if (typeof raw === 'string') return raw;
  return '—';
}

function truncate(val: unknown, max = 80): string {
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatTs(iso: string): string {
  if (iso === '—') return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function detectAnomalies(entries: AuditEntry[]): Set<string> {
  const suspicious = new Set<string>();
  const accessMap: Record<string, number[]> = {};
  const windowMs = 60 * 60 * 1000;

  for (const e of entries) {
    const key = `${e.userId ?? e.phone ?? 'anon'}`;
    const ts = e.timestamp === '—' ? Date.now() : new Date(e.timestamp).getTime();
    if (!accessMap[key]) accessMap[key] = [];
    accessMap[key].push(ts);
  }

  for (const [key, times] of Object.entries(accessMap)) {
    times.sort();
    for (let i = 0; i < times.length; i++) {
      const windowEnd = times[i] + windowMs;
      let count = 0;
      for (let j = i; j < times.length && times[j] <= windowEnd; j++) count++;
      if (count >= 5) {
        for (const e of entries) {
          if ((e.userId ?? e.phone ?? 'anon') === key) suspicious.add(e.id);
        }
        break;
      }
    }
  }

  return suspicious;
}

const EVENT_TYPES: (AuditEventType | '')[] = [
  '', 'message_sent', 'message_received', 'health_data_accessed',
  'booking_created', 'booking_cancelled', 'caregiver_matched',
  'permissions_updated', 'crisis_detected', 'payment_processed',
  'background_check_requested', 'background_check_result',
  'profile_updated', 'login', 'logout', 'admin_action',
  'intake_submitted', 'caregiver_approved', 'caregiver_suspended',
  'shift_checkin', 'emergency_triggered', 'wellbeing_checkin',
  'ai_proxy_called', 'rate_limit_hit',
];

export const AuditTrail: React.FC = () => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursors, setCursors] = useState<(QueryDocumentSnapshot<DocumentData> | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [filterType, setFilterType] = useState<AuditEventType | ''>('');
  const [filterPhone, setFilterPhone] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  const [anomalies, setAnomalies] = useState<Set<string>>(new Set());

  const fetchPage = useCallback(async (cursor: QueryDocumentSnapshot<DocumentData> | null, pageIndexArg = 0) => {
    if (!db) return null;
    const fdb = db;
    setLoading(true);
    try {
      const col = collection(fdb, 'agent_audit_log');
      let constraints: Parameters<typeof query>[1][] = [orderBy('timestamp', 'desc'), limit(PAGE_SIZE + 1)];

      if (filterType) constraints = [where('eventType', '==', filterType), ...constraints];
      if (filterDateFrom) constraints = [where('timestamp', '>=', filterDateFrom), ...constraints];
      if (filterDateTo) constraints = [where('timestamp', '<=', filterDateTo + 'T23:59:59Z'), ...constraints];
      if (cursor) constraints = [...constraints, startAfter(cursor)];

      const snap = await getDocs(query(col, ...constraints));
      let docs = snap.docs;

      // Client-side phone filter (Firestore can't index phone easily with other filters)
      if (filterPhone) {
        docs = docs.filter((d) => {
          const phone = d.data().phone ?? '';
          return phone.includes(filterPhone);
        });
      }

      const more = docs.length > PAGE_SIZE;
      const pageDocs = more ? docs.slice(0, PAGE_SIZE) : docs;

      let parsed: AuditEntry[] = pageDocs.map((d) => ({
        id: d.id,
        eventType: d.data().eventType ?? 'unknown',
        userId: d.data().userId,
        phone: d.data().phone,
        data: d.data().data ?? {},
        timestamp: parseTimestamp(d.data().timestamp),
      }));

      setHasMore(more);
      // Merge the action ledger into the first unfiltered page only. Gated on
      // pageIndex === 0 (not merely !cursor) because page 1 can legitimately
      // return a null cursor — when ledger entries fill the whole visible page —
      // and a null cursor on page 2+ would otherwise re-trigger the merge,
      // duplicating entries. With any filter active (including the client-side
      // phone filter) the ledger is skipped so filtered results stay consistent;
      // page 2+ is pure audit-log and paginates off the audit cursor.
      if (pageIndexArg === 0 && !filterType && !filterPhone && !filterDateFrom && !filterDateTo) {
       try {
        const ledgerSnap = await getDocs(query(
          collection(fdb, 'agent_action_ledger'),
          orderBy('updatedAt', 'desc'),
          limit(PAGE_SIZE)
        ));
        const ledgerEntries: AuditEntry[] = ledgerSnap.docs.map((d) => {
          const data = d.data();
          return {
            id: `ledger:${d.id}`,
            eventType: `action:${data.actionType ?? 'unknown'}`,
            userId: data.userId,
            phone: data.phone,
            data: {
              status: data.status,
              role: data.role,
              toolName: data.toolName,
              targetCollection: data.targetCollection,
              targetDocId: data.targetDocId,
              errorReason: data.errorReason,
              ...(data.metadata ?? {}),
            },
            // Fall back to epoch when both timestamps are missing so the entry
            // parses to a sortable date (epoch sorts oldest) instead of '—',
            // which would become NaN in the merge sort below.
            timestamp: parseTimestamp(data.updatedAt ?? data.createdAt ?? new Date(0).toISOString()),
          };
        });
        parsed = [...parsed, ...ledgerEntries]
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, PAGE_SIZE);
       } catch (err) {
        // A ledger read failure (missing collection/index, permissions) must not
        // blank the whole panel — fall back to showing the audit log alone.
        console.error('agent_action_ledger merge failed; showing audit log only', err);
       }
      }

      setEntries(parsed);
      setAnomalies(detectAnomalies(parsed));

      // Pagination cursor: continue from the last AUDIT-LOG entry that actually
      // survived the merge+slice above, not the last *fetched* audit doc. On
      // page 1 the ledger merge can push older audit rows off the visible page;
      // paginating from the last fetched audit doc would skip those displaced
      // rows on every later page. Surviving audit rows are always a timestamp
      // prefix of pageDocs, so the last pageDoc still present in `parsed` is the
      // boundary. When no merge happened (page 2+, or filtered), every pageDoc
      // survives and this resolves to pageDocs[last] — the original behavior.
      const survivingAuditIds = new Set(
        parsed.filter((e) => !e.id.startsWith('ledger:')).map((e) => e.id)
      );
      for (let i = pageDocs.length - 1; i >= 0; i--) {
        if (survivingAuditIds.has(pageDocs[i].id)) return pageDocs[i];
      }
      // No audit row survived the merge (every visible slot went to a newer
      // ledger entry). Returning a fetched-but-undisplayed doc here would make
      // page 2 start past rows the user never saw, skipping them — so return
      // null instead and let the caller treat it as "no further cursor".
      return null;
    } finally {
      setLoading(false);
    }
  }, [filterType, filterPhone, filterDateFrom, filterDateTo]);

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
    fetchPage(null, 0).then((lastDoc) => {
      setCursors([null, lastDoc]);
    });
  }, [fetchPage]);

  async function goNext() {
    const nextCursor = cursors[pageIndex + 1] ?? null;
    const lastDoc = await fetchPage(nextCursor, pageIndex + 1);
    setPageIndex((p) => p + 1);
    setCursors((prev) => {
      const updated = [...prev];
      updated[pageIndex + 2] = lastDoc;
      return updated;
    });
  }

  async function goPrev() {
    const prevCursor = cursors[pageIndex - 1] ?? null;
    await fetchPage(prevCursor, pageIndex - 1);
    setPageIndex((p) => p - 1);
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap gap-3 items-end">
        <div className="flex items-center gap-2 text-slate-500 shrink-0">
          <Filter className="w-4 h-4" />
          <span className="text-sm font-medium">Filters</span>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Event Type</label>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as AuditEventType | '')}
            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-300"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{t === '' ? 'All types' : t}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Phone / User ID</label>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={filterPhone}
              onChange={(e) => setFilterPhone(e.target.value)}
              placeholder="Search…"
              className="text-sm border border-slate-200 rounded-lg pl-8 pr-3 py-1.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-300 w-44"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">From</label>
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-300"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">To</label>
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-300"
          />
        </div>
      </div>

      {/* Anomaly warning */}
      {anomalies.size > 0 && (
        <div className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3 text-sm font-medium">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
          {anomalies.size} record{anomalies.size > 1 ? 's' : ''} flagged — same user accessed 5+ times within an hour on this page.
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-48">Timestamp</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-48">Event Type</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-48">User</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Data Preview</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-slate-400 text-sm">Loading…</td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-slate-400 text-sm">No audit records found.</td>
                </tr>
              ) : (
                entries.map((e) => (
                  <tr
                    key={e.id}
                    className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors ${anomalies.has(e.id) ? 'bg-amber-50/60' : ''}`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">
                      {formatTs(e.timestamp)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${getEventTypeBadge(e.eventType)}`}>
                        {anomalies.has(e.id) && <AlertTriangle className="w-3 h-3" />}
                        {e.eventType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700 text-xs font-mono">
                      {e.phone ?? e.userId ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-600 text-xs font-mono max-w-xs truncate">
                      {truncate(e.data)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 bg-slate-50">
          <span className="text-xs text-slate-500">Page {pageIndex + 1}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={goPrev}
              disabled={pageIndex === 0 || loading}
              className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={goNext}
              disabled={!hasMore || loading}
              className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function getEventTypeBadge(eventType: string): string {
  if (['crisis_detected', 'emergency_triggered', 'rate_limit_hit'].includes(eventType))
    return 'bg-red-50 text-red-700 border-red-200';
  if (['permissions_updated', 'admin_action', 'caregiver_suspended'].includes(eventType))
    return 'bg-amber-50 text-amber-700 border-amber-200';
  if (['booking_created', 'caregiver_matched', 'caregiver_approved'].includes(eventType))
    return 'bg-green-50 text-green-700 border-green-200';
  if (['payment_processed'].includes(eventType))
    return 'bg-blue-50 text-blue-700 border-blue-200';
  if (['health_data_accessed', 'background_check_requested', 'background_check_result'].includes(eventType))
    return 'bg-purple-50 text-purple-700 border-purple-200';
  return 'bg-slate-100 text-slate-600 border-slate-200';
}
