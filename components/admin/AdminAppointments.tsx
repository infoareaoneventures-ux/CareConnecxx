import React, { useState, useEffect } from 'react';
import { Calendar, Search, X, AlertCircle, RefreshCw, ChevronDown } from 'lucide-react';
import { adminService } from '../../services/api';
import { Appointment } from '../../types';

type ToastState = { msg: string; type: 'success' | 'error' } | null;

const STATUS_OPTIONS = ['all', 'confirmed', 'in-progress', 'completed', 'cancelled'] as const;

const statusColor = (s: string) => {
  switch (s) {
    case 'completed': return 'bg-green-100 text-green-700';
    case 'cancelled': return 'bg-red-100 text-red-700';
    case 'in-progress': return 'bg-blue-100 text-blue-700';
    case 'confirmed': return 'bg-slate-100 text-slate-700';
    default: return 'bg-slate-100 text-slate-500';
  }
};

const paymentColor = (s?: string) => {
  if (s === 'paid') return 'bg-green-100 text-green-700';
  if (s === 'refunded') return 'bg-orange-100 text-orange-700';
  return 'bg-slate-100 text-slate-500';
};

const formatDate = (date: string) => {
  try { return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return date; }
};

export const AdminAppointments: React.FC = () => {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const appts = await adminService.getAllAppointments();
      setAppointments(appts);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!selected || !cancelReason.trim()) return;
    setCancelling(true);
    try {
      await adminService.cancelAppointment(selected.id, cancelReason);
      setAppointments(prev => prev.map(a =>
        a.id === selected.id
          ? { ...a, status: 'cancelled' as const, cancellationReason: cancelReason, cancelledBy: 'admin' }
          : a
      ));
      setSelected(null);
      setCancelReason('');
      showToast('Appointment cancelled', 'success');
    } catch {
      showToast('Failed to cancel appointment', 'error');
    } finally {
      setCancelling(false);
    }
  };

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const openCancel = (a: Appointment) => {
    setSelected(a);
    setCancelReason('');
  };

  const filtered = appointments.filter(a => {
    const matchSearch = !search ||
      a.clientName?.toLowerCase().includes(search.toLowerCase()) ||
      a.caregiverName?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || a.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const counts = STATUS_OPTIONS.slice(1).reduce(
    (acc, s) => ({ ...acc, [s]: appointments.filter(a => a.status === s).length }),
    {} as Record<string, number>
  );

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4 p-6 border-b border-slate-100">
        {STATUS_OPTIONS.slice(1).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
            className={`rounded-xl p-4 text-left border transition-colors ${statusFilter === s ? 'border-primary-300 bg-primary-50' : 'border-slate-200 hover:bg-slate-50'}`}
          >
            <p className="text-2xl font-bold text-slate-900">{counts[s] || 0}</p>
            <p className="text-xs text-slate-500 capitalize mt-0.5">{s}</p>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by client or caregiver…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div className="relative">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="appearance-none pl-3 pr-8 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
          >
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s === 'all' ? 'All Statuses' : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        </div>
        <span className="text-xs text-slate-400 whitespace-nowrap">{filtered.length} result{filtered.length !== 1 ? 's' : ''}</span>
        <button onClick={load} className="p-2 rounded-lg hover:bg-slate-50 text-slate-500 border border-slate-200 transition-colors"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400 text-sm">Loading appointments…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-slate-400">
            <Calendar className="w-12 h-12 mb-3" />
            <p className="font-medium">No appointments found</p>
            <p className="text-sm mt-1">Try adjusting your search or filters</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
              <tr>
                {['Client', 'Caregiver', 'Date & Time', 'Duration', 'Cost', 'Payment', 'Status', ''].map(h => (
                  <th key={h} className={`text-xs font-semibold text-slate-500 uppercase px-6 py-3 ${h ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map(a => (
                <tr key={a.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4 text-sm font-medium text-slate-900">{a.clientName || '—'}</td>
                  <td className="px-6 py-4 text-sm text-slate-700">{a.caregiverName || '—'}</td>
                  <td className="px-6 py-4 text-sm text-slate-700">
                    {formatDate(a.date)}
                    {a.time && <span className="text-slate-400 ml-1.5">{a.time}</span>}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-700">{a.duration}h</td>
                  <td className="px-6 py-4 text-sm font-medium text-slate-900">${a.cost}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${paymentColor(a.paymentStatus)}`}>{a.paymentStatus || 'pending'}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${statusColor(a.status)}`}>{a.status}</span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    {a.status !== 'cancelled' && a.status !== 'completed' ? (
                      <button
                        onClick={() => openCancel(a)}
                        className="text-red-600 hover:text-red-700 text-xs font-medium border border-red-200 px-2.5 py-1 rounded-lg hover:bg-red-50 transition-colors"
                      >
                        Cancel
                      </button>
                    ) : a.status === 'cancelled' && a.cancellationReason ? (
                      <span className="text-xs text-slate-400 italic" title={a.cancellationReason}>
                        {a.cancellationReason.length > 28 ? a.cancellationReason.slice(0, 28) + '…' : a.cancellationReason}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Cancel modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900">Cancel Appointment</h3>
              <button onClick={() => setSelected(null)} className="p-1 hover:bg-slate-100 rounded-lg transition-colors"><X className="w-5 h-5 text-slate-500" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-slate-50 rounded-xl p-4 text-sm">
                <p className="font-medium text-slate-900">{selected.clientName} ↔ {selected.caregiverName}</p>
                <p className="text-slate-500 mt-0.5">{formatDate(selected.date)}{selected.time && ` at ${selected.time}`} · {selected.duration}h · ${selected.cost}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)}
                  rows={3}
                  placeholder="Reason for admin cancellation…"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                />
              </div>
              <div className="flex items-center gap-2 text-sm text-orange-700 bg-orange-50 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Both parties will be notified and lose access to this appointment.
              </div>
            </div>
            <div className="p-6 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => setSelected(null)} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors">Close</button>
              <button
                onClick={handleCancel}
                disabled={!cancelReason.trim() || cancelling}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {cancelling ? 'Cancelling…' : 'Confirm Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 ${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>{toast.msg}</div>
      )}
    </div>
  );
};
