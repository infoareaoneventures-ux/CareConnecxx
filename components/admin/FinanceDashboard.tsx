import React, { useState, useEffect } from 'react';
import { DollarSign, TrendingUp, Clock, CheckCircle, Users, AlertCircle, RefreshCw, ChevronDown, ChevronUp, Scale } from 'lucide-react';
import { db } from '../../lib/firebase';
import { shiftHoursService } from '../../services/api';
import { InvoicingTab } from './InvoicingTab';

interface FinanceMetrics {
  totalRevenue: number;
  pendingRevenue: number;
  paidThisMonth: number;
  totalInvoices: number;
  pendingInvoices: number;
  overdueInvoices: number;
  activeCaregivers: number;
  completedVisitsThisMonth: number;
}

interface PayoutRecord {
  id: string;
  caregiverName: string;
  amount: number;
  status: string;
  createdAt: string;
  visitDate?: string;
}

type ActiveTab = 'overview' | 'invoices' | 'payouts' | 'disputes';

interface CorrectionHistoryEntry {
  by: string;
  action: string;
  at: string;
  startTime?: string;
  endTime?: string;
  hours?: number;
  note?: string;
}

interface DisputedShift {
  id: string;
  appointmentId: string;
  caregiverName: string;
  clientName: string;
  submittedAt: string;
  submittedTotalHours: number;
  submittedStartTime: string;
  submittedEndTime: string;
  proposedTotalHours?: number;
  proposedStartTime?: string;
  proposedEndTime?: string;
  counterTotalHours?: number;
  counterStartTime?: string;
  counterEndTime?: string;
  counterNote?: string;
  payRate: number;
  correctionHistory?: CorrectionHistoryEntry[];
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtDuration(hours: number): string {
  const totalMins = Math.round(hours * 60);
  if (totalMins < 60) return `${totalMins} min`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const HISTORY_ACTION_LABEL: Record<string, string> = {
  submitted:           'Submitted by caregiver',
  proposed_correction: 'Client proposed correction',
  counter_proposed:    'Caregiver sent counter',
  accepted:            'Accepted',
  escalated:           'Escalated to admin',
  admin_resolved:      'Resolved by admin',
};

const DisputeCard: React.FC<{ shift: DisputedShift; onResolved: () => void }> = ({ shift, onResolved }) => {
  const [expanded,    setExpanded]    = useState(false);
  const [finalStart,  setFinalStart]  = useState(
    shift.counterStartTime ? toDateTimeLocal(shift.counterStartTime)
    : shift.proposedStartTime ? toDateTimeLocal(shift.proposedStartTime)
    : toDateTimeLocal(shift.submittedStartTime)
  );
  const [finalEnd,    setFinalEnd]    = useState(
    shift.counterEndTime ? toDateTimeLocal(shift.counterEndTime)
    : shift.proposedEndTime ? toDateTimeLocal(shift.proposedEndTime)
    : toDateTimeLocal(shift.submittedEndTime)
  );
  const [note,        setNote]        = useState('');
  const [resolving,   setResolving]   = useState(false);
  const [error,       setError]       = useState('');

  const computedHours = React.useMemo(() => {
    const s = new Date(finalStart).getTime();
    const e = new Date(finalEnd).getTime();
    if (!isFinite(s) || !isFinite(e) || e <= s) return 0;
    return Math.round(((e - s) / 3600000) * 100) / 100;
  }, [finalStart, finalEnd]);

  const handleResolve = async () => {
    if (computedHours <= 0) { setError('End must be after start.'); return; }
    setResolving(true);
    setError('');
    try {
      await shiftHoursService.adminResolve(
        shift.appointmentId,
        new Date(finalStart).toISOString(),
        new Date(finalEnd).toISOString(),
        note.trim() || undefined
      );
      onResolved();
    } catch (e: any) {
      setError(e?.message || 'Failed to resolve');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Header row */}
      <div
        className="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-slate-900 text-sm">{shift.caregiverName}</p>
            <span className="text-slate-400 text-xs">↔</span>
            <p className="text-sm text-slate-600">{shift.clientName}</p>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {new Date(shift.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs shrink-0">
          <div className="text-right">
            <p className="text-slate-400">Submitted</p>
            <p className="font-semibold text-slate-700">{fmtDuration(shift.submittedTotalHours)}</p>
          </div>
          {shift.proposedTotalHours != null && (
            <div className="text-right">
              <p className="text-slate-400">Client</p>
              <p className="font-semibold text-orange-600">{fmtDuration(shift.proposedTotalHours)}</p>
            </div>
          )}
          {shift.counterTotalHours != null && (
            <div className="text-right">
              <p className="text-slate-400">Counter</p>
              <p className="font-semibold text-yellow-600">{fmtDuration(shift.counterTotalHours)}</p>
            </div>
          )}
        </div>
        <div className="shrink-0 text-slate-400">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {/* Expanded detail + resolve form */}
      {expanded && (
        <div className="border-t border-slate-100 px-5 py-4 bg-slate-50 space-y-4">
          {/* Sides summary */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-white border border-slate-200 rounded-lg p-3">
              <p className="font-semibold text-slate-500 uppercase tracking-wide mb-1">Caregiver submitted</p>
              <p className="font-bold text-slate-900">{fmtDuration(shift.submittedTotalHours)}</p>
              <p className="text-slate-500 mt-0.5">
                {fmtTime(shift.submittedStartTime)} – {fmtTime(shift.submittedEndTime)}
              </p>
            </div>
            {shift.proposedStartTime && shift.proposedEndTime && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                <p className="font-semibold text-orange-600 uppercase tracking-wide mb-1">Client proposed</p>
                <p className="font-bold text-orange-700">{shift.proposedTotalHours != null ? fmtDuration(shift.proposedTotalHours) : '—'}</p>
                <p className="text-orange-600 mt-0.5">
                  {fmtTime(shift.proposedStartTime)} – {fmtTime(shift.proposedEndTime)}
                </p>
              </div>
            )}
            {shift.counterStartTime && shift.counterEndTime && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <p className="font-semibold text-yellow-600 uppercase tracking-wide mb-1">Caregiver counter</p>
                <p className="font-bold text-yellow-700">{shift.counterTotalHours != null ? fmtDuration(shift.counterTotalHours) : '—'}</p>
                <p className="text-yellow-600 mt-0.5">
                  {fmtTime(shift.counterStartTime)} – {fmtTime(shift.counterEndTime)}
                </p>
                {shift.counterNote && <p className="text-yellow-500 mt-0.5 italic">"{shift.counterNote}"</p>}
              </div>
            )}
          </div>

          {/* Correction history */}
          {shift.correctionHistory && shift.correctionHistory.some((e: any) => e.action !== 'submitted') && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Correction history</p>
              {shift.correctionHistory.map((entry, i) => (
                <div key={i} className="flex gap-3 text-xs">
                  <div className="flex flex-col items-center shrink-0">
                    <div className="w-2 h-2 rounded-full bg-slate-300 mt-0.5" />
                    {i < shift.correctionHistory!.length - 1 && (
                      <div className="w-px flex-1 bg-slate-200 mt-1" />
                    )}
                  </div>
                  <div className="pb-2">
                    <p className="font-semibold text-slate-700">
                      {HISTORY_ACTION_LABEL[entry.action] || entry.action}
                    </p>
                    {entry.startTime && entry.endTime && (
                      <p className="text-slate-500 mt-0.5">
                        {fmtTime(entry.startTime)} – {fmtTime(entry.endTime)}
                        {entry.hours != null ? ` · ${fmtDuration(entry.hours)}` : ''}
                      </p>
                    )}
                    {entry.note && <p className="text-slate-400 mt-0.5 italic">"{entry.note}"</p>}
                    <p className="text-slate-400 mt-0.5">
                      {new Date(entry.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {', '}
                      {new Date(entry.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Admin resolve form */}
          <div className="bg-white border border-purple-200 rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold text-purple-700 uppercase tracking-wide">Admin resolution</p>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Final start time</label>
              <input
                type="datetime-local"
                value={finalStart}
                onChange={e => setFinalStart(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Final end time</label>
              <input
                type="datetime-local"
                value={finalEnd}
                onChange={e => setFinalEnd(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              />
            </div>
            {computedHours > 0 && (
              <div className="flex items-center justify-between bg-purple-50 rounded-lg px-3 py-2 text-xs">
                <span className="text-slate-500">Final total</span>
                <span className="font-bold text-purple-700">{fmtDuration(computedHours)} · ${(computedHours * shift.payRate).toFixed(2)}</span>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Resolution note (optional)</label>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={2}
                placeholder="Reason for this resolution…"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-purple-300"
              />
            </div>
            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
            )}
            <button
              disabled={resolving || computedHours <= 0}
              onClick={handleResolve}
              className="w-full py-2.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold disabled:opacity-50 transition-colors"
            >
              {resolving ? 'Resolving…' : 'Resolve dispute'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const KPICard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color: string;
}> = ({ label, value, sub, icon, color }) => (
  <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-start gap-4">
    <div className={`p-2.5 rounded-lg ${color}`}>{icon}</div>
    <div>
      <p className="text-sm text-slate-500 font-medium">{label}</p>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  </div>
);

export const FinanceDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [metrics, setMetrics] = useState<FinanceMetrics | null>(null);
  const [payouts, setPayouts] = useState<PayoutRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [disputes, setDisputes] = useState<DisputedShift[]>([]);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);

  const loadMetrics = async () => {
    if (!db) return;
    setLoading(true);
    try {
      const [invoicesSnap, caregiversSnap, appointmentsSnap, payoutsSnap] = await Promise.all([
        db.collection('invoices').get(),
        db.collection('caregivers').where('status', '==', 'active').get(),
        db.collection('appointments')
          .where('status', '==', 'completed')
          .where('date', '>=', `${currentMonth}-01`)
          .get(),
        db.collection('payouts').orderBy('createdAt', 'desc').limit(30).get(),
      ]);

      const invoices = invoicesSnap.docs.map(d => d.data());
      const totalRevenue   = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.total ?? 0), 0);
      const pendingRevenue = invoices.filter(i => i.status === 'pending' || i.status === 'approved').reduce((s, i) => s + (i.total ?? 0), 0);
      const paidThisMonth  = invoices
        .filter(i => i.status === 'paid' && typeof i.paidAt === 'string' && i.paidAt.startsWith(currentMonth))
        .reduce((s, i) => s + (i.total ?? 0), 0);
      const overdueInvoices = invoices.filter(i =>
        (i.status === 'pending' || i.status === 'approved') &&
        typeof i.dueDate === 'string' && i.dueDate < today
      ).length;

      setMetrics({
        totalRevenue,
        pendingRevenue,
        paidThisMonth,
        totalInvoices:          invoices.length,
        pendingInvoices:        invoices.filter(i => i.status === 'pending').length,
        overdueInvoices,
        activeCaregivers:       caregiversSnap.size,
        completedVisitsThisMonth: appointmentsSnap.size,
      });

      setPayouts(payoutsSnap.docs.map(d => ({
        id:            d.id,
        caregiverName: d.data().caregiverName ?? 'Unknown',
        amount:        d.data().amount ?? 0,
        status:        d.data().status ?? 'unknown',
        createdAt:     d.data().createdAt ?? '',
        visitDate:     d.data().visitDate,
      })));

      setLastRefreshed(new Date());
    } catch (err) {
      console.error('FinanceDashboard loadMetrics error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMetrics(); }, []);

  // Real-time subscription to disputed shifts
  useEffect(() => {
    const unsub = shiftHoursService.subscribeForAdmin((rows) => {
      setDisputes(
        rows
          .filter((r: any) => r.status === 'disputed_admin_review')
          .map((r: any) => r as DisputedShift)
      );
    });
    return () => { try { (unsub as any)?.(); } catch {} };
  }, []);

  const fmt = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`;

  const tabs: { id: ActiveTab; label: string; badge?: number }[] = [
    { id: 'overview',  label: 'Overview' },
    { id: 'invoices',  label: 'Invoices' },
    { id: 'payouts',   label: 'Caregiver Payouts' },
    { id: 'disputes',  label: 'Disputes', badge: disputes.length || undefined },
  ];

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`relative flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === t.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
              {t.badge != null && t.badge > 0 && (
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          onClick={loadMetrics}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading…' : `Refreshed ${lastRefreshed.toLocaleTimeString()}`}
        </button>
      </div>

      {/* Overview tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {loading || !metrics ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-white rounded-xl border border-slate-200 p-5 h-24 animate-pulse" />
              ))}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <KPICard
                  label="Total Revenue"
                  value={fmt(metrics.totalRevenue)}
                  sub="all-time paid invoices"
                  icon={<DollarSign className="w-5 h-5 text-emerald-600" />}
                  color="bg-emerald-50"
                />
                <KPICard
                  label="Paid This Month"
                  value={fmt(metrics.paidThisMonth)}
                  sub={currentMonth}
                  icon={<TrendingUp className="w-5 h-5 text-primary-600" />}
                  color="bg-primary-50"
                />
                <KPICard
                  label="Outstanding"
                  value={fmt(metrics.pendingRevenue)}
                  sub={`${metrics.pendingInvoices} pending invoice${metrics.pendingInvoices !== 1 ? 's' : ''}`}
                  icon={<Clock className="w-5 h-5 text-amber-600" />}
                  color="bg-amber-50"
                />
                <KPICard
                  label="Overdue Invoices"
                  value={String(metrics.overdueInvoices)}
                  sub="past due date"
                  icon={<AlertCircle className="w-5 h-5 text-red-600" />}
                  color="bg-red-50"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <KPICard
                  label="Active Caregivers"
                  value={String(metrics.activeCaregivers)}
                  sub="verified & active"
                  icon={<Users className="w-5 h-5 text-indigo-600" />}
                  color="bg-indigo-50"
                />
                <KPICard
                  label="Completed Visits (month)"
                  value={String(metrics.completedVisitsThisMonth)}
                  sub={currentMonth}
                  icon={<CheckCircle className="w-5 h-5 text-teal-600" />}
                  color="bg-teal-50"
                />
              </div>

              {/* Invoice breakdown */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="text-sm font-semibold text-slate-700 mb-4">Invoice Status Breakdown</h3>
                <div className="flex gap-6 text-sm">
                  {[
                    { label: 'Total', value: metrics.totalInvoices, color: 'text-slate-700' },
                    { label: 'Pending', value: metrics.pendingInvoices, color: 'text-amber-600' },
                    { label: 'Overdue', value: metrics.overdueInvoices, color: 'text-red-600' },
                    { label: 'Paid', value: metrics.totalInvoices - metrics.pendingInvoices - metrics.overdueInvoices, color: 'text-emerald-600' },
                  ].map(item => (
                    <div key={item.label} className="flex flex-col items-center gap-1">
                      <span className={`text-2xl font-bold ${item.color}`}>{item.value}</span>
                      <span className="text-xs text-slate-500">{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent payouts preview */}
              {payouts.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-700">Recent Payouts</h3>
                    <button
                      onClick={() => setActiveTab('payouts')}
                      className="text-xs text-primary-600 hover:underline"
                    >
                      View all
                    </button>
                  </div>
                  <div className="space-y-2">
                    {payouts.slice(0, 5).map(p => (
                      <div key={p.id} className="flex items-center justify-between text-sm">
                        <div>
                          <span className="font-medium text-slate-800">{p.caregiverName}</span>
                          {p.visitDate && <span className="text-slate-400 text-xs ml-2">{p.visitDate}</span>}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            p.status === 'paid' ? 'bg-emerald-100 text-emerald-700' :
                            p.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                            'bg-slate-100 text-slate-600'
                          }`}>{p.status}</span>
                          <span className="font-semibold text-slate-800">${p.amount.toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Invoices tab */}
      {activeTab === 'invoices' && (
        <div className="bg-white p-6 rounded-xl border border-slate-200">
          <InvoicingTab />
        </div>
      )}

      {/* Disputes tab */}
      {activeTab === 'disputes' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <Scale className="w-5 h-5 text-purple-600" />
                Shift Hour Disputes
              </h3>
              <p className="text-sm text-slate-500 mt-0.5">
                Shifts escalated to admin review — resolve by setting final hours.
              </p>
            </div>
            <span className={`text-sm font-semibold px-3 py-1 rounded-full ${
              disputes.length > 0
                ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-green-50 text-green-700 border border-green-200'
            }`}>
              {disputes.length > 0 ? `${disputes.length} open` : 'All clear'}
            </span>
          </div>

          {disputes.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                <CheckCircle className="w-6 h-6 text-green-500" />
              </div>
              <p className="font-semibold text-slate-700 mb-1">No open disputes</p>
              <p className="text-sm text-slate-400">All shift hour disputes have been resolved.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {disputes.map(shift => (
                <DisputeCard
                  key={shift.id}
                  shift={shift}
                  onResolved={() => {
                    /* subscription will auto-remove the card when status changes */
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Payouts tab */}
      {activeTab === 'payouts' && (
        <div className="bg-white rounded-xl border border-slate-200">
          <div className="p-5 border-b border-slate-100">
            <h3 className="text-lg font-semibold text-slate-900">Caregiver Payouts</h3>
            <p className="text-sm text-slate-500 mt-0.5">Most recent 30 payout records</p>
          </div>
          {loading ? (
            <div className="p-8 text-center text-slate-400 text-sm">Loading…</div>
          ) : payouts.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">No payout records found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-left">
                    <th className="px-5 py-3 font-semibold">Caregiver</th>
                    <th className="px-5 py-3 font-semibold">Visit Date</th>
                    <th className="px-5 py-3 font-semibold">Amount</th>
                    <th className="px-5 py-3 font-semibold">Status</th>
                    <th className="px-5 py-3 font-semibold">Processed</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map(p => (
                    <tr key={p.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-5 py-3 font-medium text-slate-800">{p.caregiverName}</td>
                      <td className="px-5 py-3 text-slate-600">{p.visitDate ?? '—'}</td>
                      <td className="px-5 py-3 font-semibold text-slate-900">${p.amount.toFixed(2)}</td>
                      <td className="px-5 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          p.status === 'paid'    ? 'bg-emerald-100 text-emerald-700' :
                          p.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                          p.status === 'failed'  ? 'bg-red-100 text-red-700' :
                          'bg-slate-100 text-slate-600'
                        }`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-500 text-xs">
                        {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
