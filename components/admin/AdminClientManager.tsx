import React, { useState, useEffect } from 'react';
import {
  Search, User, Phone, Mail, MapPin, Calendar, Ban, CheckCircle,
  Edit2, Save, X, AlertCircle, Bell, Clock, RefreshCw, Users,
} from 'lucide-react';
import { dbService, adminService } from '../../services/api';
import { AdminUser, Appointment } from '../../types';

type Panel = 'profile' | 'appointments';

interface ClientRow extends AdminUser {
  isSuspended?: boolean;
  suspendedUntil?: string;
  suspensionReason?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  subscriptionStatus?: string;
  assignedCaregiverIds?: string[];
}

type ConfirmAction = 'ban' | 'unban' | null;

export const AdminClientManager: React.FC = () => {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended' | 'banned'>('all');
  const [selected, setSelected] = useState<ClientRow | null>(null);
  const [panel, setPanel] = useState<Panel>('profile');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<ClientRow>>({});
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [apptLoading, setApptLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [suspendDays, setSuspendDays] = useState(7);
  const [suspendReason, setSuspendReason] = useState('');
  const [showSuspendForm, setShowSuspendForm] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [notifyMsg, setNotifyMsg] = useState('');
  const [showNotifyForm, setShowNotifyForm] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const all = await dbService.getAllUsers();
      setClients(all.filter(u => u.userType === 'client') as ClientRow[]);
    } finally {
      setLoading(false);
    }
  };

  const openClient = (c: ClientRow) => {
    setSelected(c);
    setForm({ name: c.name, email: c.email, phone: c.phone, address: c.address, city: c.city, state: c.state, zipCode: c.zipCode });
    setEditing(false);
    setPanel('profile');
    setShowSuspendForm(false);
    setShowNotifyForm(false);
    setConfirmAction(null);
    setSuspendReason('');
    setSuspendDays(7);
    setNotifyMsg('');
  };

  const loadAppointments = async (clientId: string) => {
    setApptLoading(true);
    try {
      setAppointments(await adminService.getClientAppointments(clientId));
    } finally { setApptLoading(false); }
  };

  const handlePanelSwitch = (p: Panel) => {
    setPanel(p);
    if (p === 'appointments' && selected) loadAppointments(selected.uid);
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await adminService.updateClient(selected.uid, form);
      const updated = { ...selected, ...form };
      setClients(prev => prev.map(c => c.uid === selected.uid ? updated : c));
      setSelected(updated);
      setEditing(false);
      showToast('Client updated', 'success');
    } catch { showToast('Failed to save changes', 'error'); }
    finally { setSaving(false); }
  };

  const handleBan = async () => {
    if (!selected) return;
    try {
      await dbService.banUser(selected.uid);
      patch({ isBanned: true });
      showToast(`${selected.name} banned`, 'success');
    } catch { showToast('Failed to ban user', 'error'); }
    finally { setConfirmAction(null); }
  };

  const handleUnban = async () => {
    if (!selected) return;
    try {
      await adminService.unbanUser(selected.uid);
      patch({ isBanned: false });
      showToast(`${selected.name} unbanned`, 'success');
    } catch { showToast('Failed to unban user', 'error'); }
    finally { setConfirmAction(null); }
  };

  const handleSuspend = async () => {
    if (!selected || !suspendReason.trim()) return;
    try {
      await adminService.suspendUser(selected.uid, suspendReason, suspendDays);
      patch({ isSuspended: true });
      setShowSuspendForm(false);
      setSuspendReason('');
      showToast(`${selected.name} suspended for ${suspendDays} days`, 'success');
    } catch { showToast('Failed to suspend user', 'error'); }
  };

  const handleUnsuspend = async () => {
    if (!selected) return;
    try {
      await adminService.unsuspendUser(selected.uid);
      patch({ isSuspended: false });
      showToast(`${selected.name} unsuspended`, 'success');
    } catch { showToast('Failed to unsuspend user', 'error'); }
  };

  const handleNotify = async () => {
    if (!selected || !notifyMsg.trim()) return;
    setSending(true);
    try {
      await dbService.sendNotification(selected.uid, {
        type: 'admin_message', title: 'Message from CareConnex',
        body: notifyMsg, message: notifyMsg, userId: selected.uid, isRead: false,
      });
      setNotifyMsg('');
      setShowNotifyForm(false);
      showToast('Notification sent', 'success');
    } catch { showToast('Failed to send notification', 'error'); }
    finally { setSending(false); }
  };

  const handleApprove = async () => {
    if (!selected) return;
    try {
      await adminService.updateClient(selected.uid, {
        verified: true,
        membershipPaid: true,
        subscriptionActive: true,
        membershipStatus: 'active',
        identityCheckStatus: 'verified',
        onboardingStep: 3,
        approvedAt: new Date().toISOString(),
        approvedBy: 'admin',
      } as any);
      patch({ verified: true, isBanned: false, isSuspended: false });
      showToast(`${selected.name} approved`, 'success');
    } catch { showToast('Failed to approve client', 'error'); }
  };

  const patch = (updates: Partial<ClientRow>) => {
    setClients(prev => prev.map(c => c.uid === selected!.uid ? { ...c, ...updates } : c));
    setSelected(prev => prev ? { ...prev, ...updates } : prev);
  };

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const statusLabel = (c: ClientRow) => {
    if (c.isBanned) return 'Banned';
    if (c.isSuspended) return 'Suspended';
    if (c.verified) return 'Active';
    return 'Pending';
  };

  const statusColor = (c: ClientRow) => {
    if (c.isBanned) return 'bg-red-100 text-red-700';
    if (c.isSuspended) return 'bg-orange-100 text-orange-700';
    if (c.verified) return 'bg-green-100 text-green-700';
    return 'bg-slate-100 text-slate-600';
  };

  const filtered = clients.filter(c => {
    const matchSearch = !search ||
      c.name?.toLowerCase().includes(search.toLowerCase()) ||
      c.email?.toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.includes(search);
    const matchStatus =
      statusFilter === 'all' ||
      (statusFilter === 'banned' && c.isBanned) ||
      (statusFilter === 'suspended' && c.isSuspended && !c.isBanned) ||
      (statusFilter === 'active' && !c.isBanned && !c.isSuspended && c.verified);
    return matchSearch && matchStatus;
  });

  const fields = [
    { label: 'Full Name', key: 'name', icon: User, span: 2 },
    { label: 'Email', key: 'email', icon: Mail, span: 2 },
    { label: 'Phone', key: 'phone', icon: Phone, span: 1 },
    { label: 'Address', key: 'address', icon: MapPin, span: 2 },
    { label: 'City', key: 'city', icon: MapPin, span: 1 },
    { label: 'State', key: 'state', icon: MapPin, span: 1 },
    { label: 'ZIP', key: 'zipCode', icon: MapPin, span: 1 },
  ] as const;

  return (
    <div className="flex h-full">
      {/* ── List pane ── */}
      <div className={`${selected ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-80 border-r border-slate-200 bg-white shrink-0`}>
        {/* Toolbar */}
        <div className="p-3 border-b border-slate-100 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div className="flex gap-1">
            {(['all', 'active', 'suspended', 'banned'] as const).map(f => (
              <button key={f} onClick={() => setStatusFilter(f)}
                className={`flex-1 py-1 text-xs rounded-full font-medium capitalize transition-colors ${statusFilter === f ? 'bg-primary-100 text-primary-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-slate-300">
              <Users className="w-10 h-10 mb-2" />
              <p className="text-sm text-slate-400">No clients found</p>
            </div>
          ) : filtered.map(c => (
            <button key={c.uid} onClick={() => openClient(c)}
              className={`w-full text-left flex items-center gap-3 px-4 py-3 border-b border-slate-50 hover:bg-slate-50 transition-colors ${selected?.uid === c.uid ? 'bg-primary-50 border-l-2 border-l-primary-500' : ''}`}>
              <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center shrink-0">
                <span className="text-primary-700 font-bold text-sm">{c.name?.charAt(0)?.toUpperCase() || '?'}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-900 text-sm truncate">{c.name}</p>
                <p className="text-xs text-slate-400 truncate">{c.email}</p>
              </div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${statusColor(c)}`}>{statusLabel(c)}</span>
            </button>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-400">{filtered.length} of {clients.length} clients</span>
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* ── Detail pane ── */}
      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
          {/* Header */}
          <div className="bg-white border-b border-slate-200 px-5 py-4 flex items-center gap-3 shrink-0">
            <button onClick={() => setSelected(null)} className="lg:hidden p-1.5 rounded-lg hover:bg-slate-100"><X className="w-4 h-4" /></button>
            <div className="w-11 h-11 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-lg shrink-0">
              {selected.name?.charAt(0)?.toUpperCase() || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="font-bold text-slate-900 truncate">{selected.name}</h2>
              <p className="text-sm text-slate-500 truncate">{selected.email}</p>
            </div>
            <span className={`text-sm font-medium px-3 py-1 rounded-full shrink-0 ${statusColor(selected)}`}>{statusLabel(selected)}</span>
          </div>

          {/* Sub-tabs */}
          <div className="bg-white border-b border-slate-200 flex px-5">
            {(['profile', 'appointments'] as Panel[]).map(p => (
              <button key={p} onClick={() => handlePanelSwitch(p)}
                className={`px-4 py-3 text-sm font-medium capitalize border-b-2 transition-colors ${panel === p ? 'border-primary-600 text-primary-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                {p}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {panel === 'profile' && (
              <>
                {/* Profile form */}
                <div className="bg-white rounded-xl border border-slate-200 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-slate-900">Profile Information</h3>
                    {!editing ? (
                      <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 font-medium">
                        <Edit2 className="w-3.5 h-3.5" /> Edit
                      </button>
                    ) : (
                      <div className="flex gap-2">
                        <button onClick={() => setEditing(false)} className="px-3 py-1 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">Cancel</button>
                        <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 px-3 py-1 text-sm bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 disabled:opacity-50">
                          <Save className="w-3.5 h-3.5" />{saving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {fields.map(({ label, key, icon: Icon, span }) => (
                      <div key={key} className={span === 2 ? 'col-span-2' : ''}>
                        <label className="block text-xs font-medium text-slate-500 mb-1 flex items-center gap-1">
                          <Icon className="w-3 h-3" />{label}
                        </label>
                        {editing ? (
                          <input
                            value={(form as any)[key] || ''}
                            onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                        ) : (
                          <p className="text-sm text-slate-900 py-0.5">{(selected as any)[key] || <span className="text-slate-400 italic">Not set</span>}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Account info */}
                <div className="bg-white rounded-xl border border-slate-200 p-5">
                  <h3 className="font-semibold text-slate-900 mb-3">Account</h3>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      ['Joined', selected.createdAt ? new Date(selected.createdAt).toLocaleDateString() : 'Unknown'],
                      ['Subscription', (selected as any).subscriptionStatus || 'N/A'],
                      ['Caregivers', (selected as any).assignedCaregiverIds?.length ?? 0],
                    ].map(([label, val]) => (
                      <div key={label} className="bg-slate-50 rounded-lg p-3">
                        <p className="text-xs text-slate-400 mb-0.5">{label}</p>
                        <p className="text-sm font-semibold text-slate-900 capitalize">{val}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Moderation */}
                <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
                  <h3 className="font-semibold text-slate-900">Moderation</h3>

                  {/* Status alerts */}
                  {selected.isBanned && (
                    <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                      <AlertCircle className="w-4 h-4 shrink-0" /> This user is banned.
                    </div>
                  )}
                  {selected.isSuspended && !selected.isBanned && (
                    <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-sm text-orange-700">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      Suspended until {selected.suspendedUntil ? new Date(selected.suspendedUntil).toLocaleDateString() : '—'}.
                      {selected.suspensionReason && <span className="ml-1">Reason: {selected.suspensionReason}</span>}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex flex-wrap gap-2">
                    {!selected.verified && !selected.isBanned && (
                      <button onClick={handleApprove} className="flex items-center gap-1.5 px-3 py-2 text-sm border border-green-300 text-green-700 rounded-lg hover:bg-green-50 font-medium">
                        <CheckCircle className="w-4 h-4" /> Approve
                      </button>
                    )}
                    <button onClick={() => setShowNotifyForm(v => !v)} className="flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700">
                      <Bell className="w-4 h-4" /> Notify
                    </button>
                    {selected.isSuspended ? (
                      <button onClick={handleUnsuspend} className="flex items-center gap-1.5 px-3 py-2 text-sm border border-green-300 text-green-700 rounded-lg hover:bg-green-50">
                        <CheckCircle className="w-4 h-4" /> Unsuspend
                      </button>
                    ) : (
                      !selected.isBanned && (
                        <button onClick={() => setShowSuspendForm(v => !v)} className="flex items-center gap-1.5 px-3 py-2 text-sm border border-orange-300 text-orange-700 rounded-lg hover:bg-orange-50">
                          <Clock className="w-4 h-4" /> Suspend
                        </button>
                      )
                    )}
                    {selected.isBanned ? (
                      <button onClick={() => setConfirmAction('unban')} className="flex items-center gap-1.5 px-3 py-2 text-sm border border-green-300 text-green-700 rounded-lg hover:bg-green-50">
                        <CheckCircle className="w-4 h-4" /> Unban
                      </button>
                    ) : (
                      <button onClick={() => setConfirmAction('ban')} className="flex items-center gap-1.5 px-3 py-2 text-sm border border-red-300 text-red-700 rounded-lg hover:bg-red-50">
                        <Ban className="w-4 h-4" /> Ban
                      </button>
                    )}
                  </div>

                  {/* Notify form */}
                  {showNotifyForm && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
                      <textarea
                        value={notifyMsg} onChange={e => setNotifyMsg(e.target.value)}
                        placeholder="Message to send to this client…"
                        rows={2} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg resize-none focus:outline-none"
                      />
                      <div className="flex justify-end gap-2">
                        <button onClick={() => { setShowNotifyForm(false); setNotifyMsg(''); }} className="px-3 py-1 text-sm text-slate-500 hover:text-slate-700">Cancel</button>
                        <button onClick={handleNotify} disabled={!notifyMsg.trim() || sending} className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
                          {sending ? 'Sending…' : 'Send'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Suspend form */}
                  {showSuspendForm && !selected.isBanned && (
                    <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 space-y-2">
                      <input
                        value={suspendReason} onChange={e => setSuspendReason(e.target.value)}
                        placeholder="Reason for suspension…"
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none"
                      />
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-slate-600">Duration:</label>
                        <input type="number" min={1} max={365} value={suspendDays} onChange={e => setSuspendDays(Number(e.target.value))}
                          className="w-20 px-2 py-1 text-sm border border-slate-200 rounded-lg text-center" />
                        <span className="text-xs text-slate-500">days</span>
                        <button onClick={() => { setShowSuspendForm(false); setSuspendReason(''); }} className="ml-auto text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                        <button onClick={handleSuspend} disabled={!suspendReason.trim()} className="px-3 py-1 text-sm bg-orange-600 text-white rounded-lg font-medium hover:bg-orange-700 disabled:opacity-50">Confirm</button>
                      </div>
                    </div>
                  )}

                  {/* Ban / Unban confirm */}
                  {confirmAction && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <p className="text-sm text-red-700 mb-2 font-medium">
                        {confirmAction === 'ban' ? `Ban ${selected.name}? They will lose all access.` : `Unban ${selected.name}?`}
                      </p>
                      <div className="flex gap-2">
                        <button onClick={() => setConfirmAction(null)} className="px-3 py-1 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-white">Cancel</button>
                        <button
                          onClick={confirmAction === 'ban' ? handleBan : handleUnban}
                          className="px-3 py-1 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700">
                          {confirmAction === 'ban' ? 'Confirm Ban' : 'Confirm Unban'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {panel === 'appointments' && (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {apptLoading ? (
                  <div className="flex items-center justify-center py-16 text-slate-400 text-sm">Loading…</div>
                ) : appointments.length === 0 ? (
                  <div className="flex flex-col items-center py-16 text-slate-300">
                    <Calendar className="w-10 h-10 mb-2" />
                    <p className="text-sm text-slate-400">No appointments found</p>
                  </div>
                ) : (
                  <table className="w-full">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        {['Caregiver', 'Date', 'Duration', 'Cost', 'Status'].map(h => (
                          <th key={h} className="text-left text-xs font-semibold text-slate-500 uppercase px-4 py-3">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {appointments.map(a => (
                        <tr key={a.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 text-sm font-medium text-slate-900">{a.caregiverName}</td>
                          <td className="px-4 py-3 text-sm text-slate-600">{a.date} · {a.time}</td>
                          <td className="px-4 py-3 text-sm text-slate-600">{a.duration}h</td>
                          <td className="px-4 py-3 text-sm text-slate-600">${a.cost}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                              a.status === 'completed' ? 'bg-green-100 text-green-700' :
                              a.status === 'cancelled' ? 'bg-red-100 text-red-700' :
                              a.status === 'in-progress' ? 'bg-blue-100 text-blue-700' :
                              'bg-slate-100 text-slate-600'}`}>{a.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 hidden lg:flex items-center justify-center text-slate-300 flex-col gap-2">
          <Users className="w-16 h-16" />
          <p className="text-slate-400 text-sm">Select a client to view details</p>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 ${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
};
