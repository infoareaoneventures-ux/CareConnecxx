import React, { useState, useEffect } from 'react';
import { DollarSign, TrendingUp, Clock, CheckCircle, Users, AlertCircle, RefreshCw } from 'lucide-react';
import { db } from '../../lib/firebase';
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

type ActiveTab = 'overview' | 'invoices' | 'payouts';

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

  const fmt = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`;

  const tabs: { id: ActiveTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'invoices', label: 'Invoices' },
    { id: 'payouts',  label: 'Caregiver Payouts' },
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
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === t.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
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
