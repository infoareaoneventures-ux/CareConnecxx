import React, { useState, useEffect } from 'react';
import { Flag, CheckCircle, Trash2, ChevronDown, ChevronUp, User } from 'lucide-react';
import { db } from '../../lib/firebase';
import firebase from 'firebase/compat/app';

interface Report {
  id: string;
  reportedBy: string;
  reportedUser: string;
  reportedUserName: string;
  reason: string;
  createdAt: any;
  status?: 'new' | 'reviewed';
  reporterName?: string;
}

function formatDate(ts: any): string {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const AdminReports: React.FC = () => {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'new' | 'reviewed'>('all');
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    if (!db) return;
    const unsub = db.collection('reports')
      .orderBy('createdAt', 'desc')
      .onSnapshot(async snap => {
        const raw: Report[] = snap.docs.map(d => ({
          id: d.id,
          ...(d.data() as Omit<Report, 'id'>),
          status: (d.data() as any).status || 'new',
        }));

        // Batch-fetch reporter display names
        const uniqueReporterIds = [...new Set(raw.map(r => r.reportedBy).filter(Boolean))];
        const nameMap: Record<string, string> = {};
        await Promise.all(
          uniqueReporterIds.map(async uid => {
            try {
              const snap = await db!.collection('users').doc(uid).get();
              const data = snap.data() as any;
              nameMap[uid] = data?.displayName || data?.name || data?.email?.split('@')[0] || uid.slice(0, 8);
            } catch {
              nameMap[uid] = uid.slice(0, 8);
            }
          })
        );

        setReports(raw.map(r => ({ ...r, reporterName: nameMap[r.reportedBy] || r.reportedBy?.slice(0, 8) })));
        setLoading(false);
      }, () => setLoading(false));
    return unsub;
  }, []);

  const markReviewed = async (id: string) => {
    if (!db) return;
    await db.collection('reports').doc(id).update({ status: 'reviewed' });
    showToast('Marked as reviewed');
  };

  const dismiss = async (id: string) => {
    if (!db) return;
    await db.collection('reports').doc(id).delete();
    showToast('Report dismissed');
  };

  const filtered = reports.filter(r => filter === 'all' ? true : r.status === filter);
  const newCount = reports.filter(r => r.status === 'new').length;

  return (
    <div className="h-full overflow-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Flag className="w-5 h-5 text-red-500" />
            User Reports
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">{newCount} new report{newCount !== 1 ? 's' : ''} requiring review</p>
        </div>
        <div className="flex gap-2">
          {(['all', 'new', 'reviewed'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors ${
                filter === f ? 'bg-primary-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {f}{f === 'new' && newCount > 0 ? ` (${newCount})` : ''}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-400 text-sm">Loading reports…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <Flag className="w-12 h-12 text-slate-200 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">No reports</p>
          <p className="text-slate-400 text-sm mt-1">{filter !== 'all' ? `No ${filter} reports` : 'No user reports submitted yet'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(report => (
            <div key={report.id} className={`bg-white rounded-xl border transition-all ${report.status === 'new' ? 'border-red-200 shadow-sm' : 'border-slate-200'}`}>
              {/* Row */}
              <div className="flex items-center gap-4 px-5 py-4">
                {/* Reported user avatar */}
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                  <User className="w-5 h-5 text-red-500" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-slate-900 text-sm">{report.reportedUserName || 'Unknown user'}</p>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      report.status === 'new' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                    }`}>
                      {report.status === 'new' ? 'New' : 'Reviewed'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Reported by <span className="font-medium text-slate-700">{report.reporterName}</span> · {formatDate(report.createdAt)}
                  </p>
                </div>

                {/* Reason pill */}
                <span className="px-3 py-1 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-xs font-medium hidden sm:block flex-shrink-0">
                  {report.reason}
                </span>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {report.status === 'new' && (
                    <button
                      onClick={() => markReviewed(report.id)}
                      title="Mark reviewed"
                      className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                    >
                      <CheckCircle className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => dismiss(report.id)}
                    title="Dismiss report"
                    className="p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setExpandedId(expandedId === report.id ? null : report.id)}
                    className="p-2 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors"
                  >
                    {expandedId === report.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Expanded detail */}
              {expandedId === report.id && (
                <div className="border-t border-slate-100 px-5 py-4 bg-slate-50 rounded-b-xl grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Reported User</p>
                    <p className="font-medium text-slate-900">{report.reportedUserName}</p>
                    <p className="text-xs text-slate-500 font-mono mt-0.5">{report.reportedUser}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Reported By</p>
                    <p className="font-medium text-slate-900">{report.reporterName}</p>
                    <p className="text-xs text-slate-500 font-mono mt-0.5">{report.reportedBy}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Reason</p>
                    <p className="text-slate-700">{report.reason}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Submitted</p>
                    <p className="text-slate-700">{formatDate(report.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Status</p>
                    <p className={`font-medium capitalize ${report.status === 'new' ? 'text-red-600' : 'text-green-600'}`}>{report.status}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 bg-slate-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50">{toast}</div>
      )}
    </div>
  );
};
