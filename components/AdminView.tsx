import React, { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard, Calendar, DollarSign, Activity,
  ChevronLeft, AlertCircle, MessageSquare, Search,
  FileText, TrendingUp, UserCheck, X, HeartHandshake,
  Heart, Users, Phone, Filter, Download, Shield,
  Star, ClipboardList, BookOpen, ShieldCheck, BellRing, Sparkles, Flag,
} from 'lucide-react';
import { SupportTicket, AdminUser, JobPost, Caregiver, ClientIntakeData } from '../types';
import { dbService } from '../services/api';
import { TicketManager } from './admin/TicketManager';
import { AdminShiftHoursMediation } from './payroll/AdminShiftHoursMediation';
import { MatchingDashboard } from './admin/MatchingDashboard';
import { AssignmentManager } from './admin/AssignmentManager';
import { InvoicingTab } from './admin/InvoicingTab';
import { AdminMessages } from './admin/AdminMessages';
import { AdminClientManager } from './admin/AdminClientManager';
import { AdminCaregiverManager } from './admin/AdminCaregiverManager';
import { AdminAppointments } from './admin/AdminAppointments';
import { AdminReviews } from './admin/AdminReviews';
import { CaregiverVerificationDashboard } from './admin/CaregiverVerificationDashboard';
import { CoordinatorManagement } from './admin/CoordinatorManagement';
import { AdminBlogManager } from './admin/AdminBlogManager';
import { AuditTrail } from './admin/AuditTrail';
import { ProactiveReflectionDashboard } from './admin/ProactiveReflectionDashboard';
import { AdminAlertsPanel } from './admin/AdminAlertsPanel';
import { AdminCaraControlRoom } from './admin/AdminCaraControlRoom';
import { AdminReports } from './admin/AdminReports';

interface AdminViewProps {
  onBack: () => void;
}

type TabId =
  | 'overview' | 'clients' | 'caregivers' | 'verification' | 'coordinators'
  | 'appointments' | 'reviews' | 'intakes' | 'matching' | 'assignments'
  | 'finance' | 'disputes' | 'tickets' | 'messages' | 'blog' | 'audit'
  | 'cara_control' | 'proactive_drafts' | 'alerts' | 'reports';

const StatCard = ({ icon: Icon, label, value, trend, color, onClick }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  trend?: number;
  color: string;
  onClick?: () => void;
}) => (
  <button
    onClick={onClick}
    className={`bg-white rounded-xl p-6 shadow-sm border border-slate-100 hover:shadow-md transition-all text-left w-full ${onClick ? 'cursor-pointer hover:border-primary-200' : 'cursor-default'}`}
  >
    <div className="flex items-start justify-between">
      <div>
        <p className="text-sm font-medium text-slate-500 mb-1">{label}</p>
        <h3 className="text-2xl font-bold text-slate-900">{value}</h3>
        {trend !== undefined && (
          <p className={`text-xs mt-1 flex items-center gap-1 ${trend >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            <TrendingUp className="w-3 h-3" />
            {trend >= 0 ? '+' : ''}{trend}% this month
          </p>
        )}
      </div>
      <div className={`p-3 rounded-xl ${color}`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
    </div>
  </button>
);

const StatusBadge = ({ status }: { status: string }) => {
  const map: Record<string, string> = {
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    contacted: 'bg-blue-50 text-blue-700 border-blue-200',
    active: 'bg-green-50 text-green-700 border-green-200',
    completed: 'bg-slate-50 text-slate-700 border-slate-200',
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${map[status] ?? map.pending}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
};

export const AdminView: React.FC<AdminViewProps> = ({ onBack }) => {
  const [stats, setStats] = useState({ users: 0, clients: 0, caregivers: 0, appointments: 0, revenue: 0 });
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [pendingCaregivers, setPendingCaregivers] = useState<Caregiver[]>([]);
  const [intakeLeads, setIntakeLeads] = useState<ClientIntakeData[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLead, setSelectedLead] = useState<ClientIntakeData | null>(null);
  const [dbStatus, setDbStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [newReportsCount, setNewReportsCount] = useState(0);

  useEffect(() => {
    (async () => {
      const ok = await dbService.verifyConnection();
      setDbStatus(ok ? 'connected' : 'disconnected');
      if (ok) {
        const s = await dbService.getSystemStats();
        setStats(s);
        // 'exceptions' = docs awaiting review + background-check exception states
        // (Checkr-clear caregivers are auto-approved and never enter this queue)
        const pending = await dbService.getCaregiversForVerification('exceptions');
        setPendingCaregivers(pending as Caregiver[]);
      }
    })();
  }, []);

  useEffect(() => {
    const unsub = dbService.subscribeToTickets(setTickets);
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = dbService.subscribeToIntakeLeads(setIntakeLeads);
    return () => unsub();
  }, []);

  const [openAlertsCount, setOpenAlertsCount] = useState(0);
  const [caraFailedCount, setCaraFailedCount] = useState(0);
  const [caraPendingCount, setCaraPendingCount] = useState(0);
  useEffect(() => {
    const unsub = dbService.subscribeAdminAlerts((alerts) =>
      setOpenAlertsCount(alerts.filter(a => !a.resolved).length)
    );
    return () => unsub();
  }, []);
  // Cara Control surfaces more than open alerts (failed actions + pending
  // approvals too), so its badge needs its own count — not the plain alert count
  // the Alerts tab uses. Mirrors AdminCaraControlRoom's queue composition.
  useEffect(() => {
    const unsub = dbService.subscribeAgentActionLedger((rows) =>
      setCaraFailedCount(rows.filter(r => r.status === 'failed').length)
    );
    return () => unsub();
  }, []);
  useEffect(() => {
    const unsub = dbService.subscribePendingActions((rows) =>
      setCaraPendingCount(rows.filter(r => ['awaiting', 'executing', 'failed'].includes(String(r.status ?? 'awaiting'))).length)
    );
    return () => unsub();
  }, []);
  const caraOpsCount = openAlertsCount + caraFailedCount + caraPendingCount;

  useEffect(() => {
    const unsub = dbService.subscribeNewReportsCount(setNewReportsCount);
    return () => unsub();
  }, []);

  // `type` is accepted to satisfy the onShowToast contract used by child panels
  // (success/error/info) but intentionally ignored — all toasts share styling.
  // Memoized so children with onShowToast-keyed subscription effects (e.g.
  // AdminCaraControlRoom) don't resubscribe their Firestore listeners on every
  // AdminView render.
  const showToast = useCallback((msg: string, _type: 'success' | 'error' | 'info' = 'info') => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  }, []);

  const handleMarkContacted = async (userId: string) => {
    try {
      await dbService.updateIntakeLead(userId, { status: 'contacted', contactedAt: new Date().toISOString() });
      setIntakeLeads(prev => prev.map(l => l.userId === userId ? { ...l, status: 'contacted' } : l));
      setSelectedLead(null);
      showToast('Marked as contacted');
    } catch { showToast('Failed to update lead'); }
  };

  const pendingLeadsCount = intakeLeads.filter(l => l.status === 'pending').length;
  const openTicketsCount = tickets.filter(t => t.status === 'open').length;

  const filteredLeads = intakeLeads.filter(l =>
    !searchQuery ||
    l.contactName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    l.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    l.phone?.includes(searchQuery)
  );

  const navGroups = [
    {
      label: 'People',
      items: [
        { id: 'clients' as TabId, label: 'Clients', icon: Heart },
        { id: 'caregivers' as TabId, label: 'Caregivers', icon: UserCheck },
        { id: 'verification' as TabId, label: 'Verification', icon: ShieldCheck },
      ],
    },
    {
      label: 'Operations',
      items: [
        { id: 'appointments' as TabId, label: 'Appointments', icon: Calendar },
        { id: 'reviews' as TabId, label: 'Reviews', icon: Star },
        { id: 'intakes' as TabId, label: 'Intake Leads', icon: FileText, badge: pendingLeadsCount },
        { id: 'matching' as TabId, label: 'Matching', icon: HeartHandshake },
        { id: 'assignments' as TabId, label: 'Assignments', icon: ClipboardList },
      ],
    },
    {
      label: 'Finance & Support',
      items: [
        { id: 'finance' as TabId, label: 'Invoicing', icon: DollarSign },
        { id: 'disputes' as TabId, label: 'Shift Disputes', icon: AlertCircle },
        { id: 'tickets' as TabId, label: 'Support', icon: MessageSquare, badge: openTicketsCount },
        { id: 'alerts' as TabId, label: 'Alerts', icon: BellRing, badge: openAlertsCount },
        { id: 'messages' as TabId, label: 'Messages', icon: MessageSquare },
      ],
    },
    {
      label: 'Content',
      items: [
        { id: 'blog' as TabId, label: 'Blog Manager', icon: BookOpen },
      ],
    },
    {
      label: 'AI Review',
      items: [
        { id: 'cara_control' as TabId, label: 'Cara Control', icon: Sparkles, badge: caraOpsCount },
        { id: 'proactive_drafts' as TabId, label: 'Cara Drafts', icon: HeartHandshake },
      ],
    },
    {
      label: 'Security',
      items: [
        { id: 'reports' as TabId, label: 'Reports', icon: Flag, badge: newReportsCount },
        { id: 'audit' as TabId, label: 'Audit Log', icon: Shield },
      ],
    },
  ];

  const allNavItems = [{ id: 'overview' as TabId, label: 'Overview', icon: LayoutDashboard }, ...navGroups.flatMap(g => g.items)];
  const currentLabel = allNavItems.find(n => n.id === activeTab)?.label ?? '';

  // Tabs that fill the full content area without internal padding
  const fullBleedTabs: TabId[] = ['clients', 'caregivers', 'verification', 'coordinators', 'appointments', 'reviews', 'matching', 'assignments', 'disputes', 'messages', 'blog', 'cara_control', 'proactive_drafts', 'reports'];
  const isFullBleed = fullBleedTabs.includes(activeTab);

  return (
    <div className="h-screen bg-slate-50 flex overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col shrink-0">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-primary-600 rounded-xl flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="font-bold text-slate-900 text-sm leading-tight">CareConnex</p>
              <p className="text-xs text-slate-400">Admin</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-3">
          {/* Overview */}
          <button
            onClick={() => setActiveTab('overview')}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mb-3 ${activeTab === 'overview' ? 'bg-primary-50 text-primary-700' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            <LayoutDashboard className="w-4 h-4 shrink-0" />
            Overview
          </button>

          {navGroups.map(group => (
            <div key={group.label} className="mb-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-3 mb-1">{group.label}</p>
              {group.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors mb-0.5 ${activeTab === item.id ? 'bg-primary-50 text-primary-700' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{item.label}</span>
                  {(item as any).badge > 0 && (
                    <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                      {(item as any).badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Status + Back */}
        <div className="p-3 border-t border-slate-100 space-y-2">
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
            <span className={`w-2 h-2 rounded-full shrink-0 ${dbStatus === 'connected' ? 'bg-green-500' : dbStatus === 'checking' ? 'bg-amber-400' : 'bg-red-500'}`} />
            {dbStatus === 'connected' ? 'Database connected' : dbStatus === 'checking' ? 'Connecting…' : 'Database offline'}
          </div>
          <button
            onClick={onBack}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-500 hover:bg-slate-50 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to App
          </button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 shrink-0 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">{currentLabel}</h2>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span className="hidden sm:block">
              {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
          </div>
        </header>

        {/* Tab content */}
        {isFullBleed ? (
          <div className="flex-1 overflow-hidden">
            {activeTab === 'clients'      && <AdminClientManager />}
            {activeTab === 'caregivers'   && <AdminCaregiverManager />}
            {activeTab === 'verification' && <CaregiverVerificationDashboard onShowToast={(msg, type) => showToast(msg)} />}
            {activeTab === 'coordinators' && <CoordinatorManagement onShowToast={(msg, type) => showToast(msg)} />}
            {activeTab === 'appointments' && <AdminAppointments />}
            {activeTab === 'reviews'      && <AdminReviews />}
            {activeTab === 'matching'     && <MatchingDashboard coordinatorId="admin" />}
            {activeTab === 'assignments'  && <AssignmentManager />}
            {activeTab === 'disputes'     && <AdminShiftHoursMediation />}
            {activeTab === 'messages'     && <AdminMessages />}
            {activeTab === 'blog'         && <AdminBlogManager />}
            {activeTab === 'cara_control' && <AdminCaraControlRoom onShowToast={showToast} onNavigate={(tab) => setActiveTab(tab as TabId)} />}
            {activeTab === 'proactive_drafts' && <ProactiveReflectionDashboard onShowToast={(msg) => showToast(msg)} />}
            {activeTab === 'reports'      && <AdminReports />}
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-6 space-y-6">

            {/* ── OVERVIEW ─────────────────────────────── */}
            {activeTab === 'overview' && (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard icon={Heart}     label="Clients"      value={stats.clients}      trend={5}  color="bg-teal-500"    onClick={() => setActiveTab('clients')} />
                  <StatCard icon={UserCheck} label="Caregivers"   value={stats.caregivers}   trend={8}  color="bg-primary-500" onClick={() => setActiveTab('caregivers')} />
                  <StatCard icon={Calendar}  label="Appointments" value={stats.appointments}  trend={-3} color="bg-blue-500"  onClick={() => setActiveTab('appointments')} />
                  <StatCard icon={DollarSign}label="Revenue"      value={`$${stats.revenue.toLocaleString()}`} trend={24} color="bg-green-500" onClick={() => setActiveTab('finance')} />
                </div>

                <div className="grid lg:grid-cols-3 gap-4">
                  {/* Pending Verifications */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-slate-900 text-sm">Pending Verifications</h3>
                      <button onClick={() => setActiveTab('verification')} className="text-xs text-primary-600 hover:text-primary-700 font-medium">
                        View all →
                      </button>
                    </div>
                    {pendingCaregivers.length === 0 ? (
                      <div className="text-center py-6">
                        <Shield className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                        <p className="text-sm text-slate-400">All clear</p>
                      </div>
                    ) : pendingCaregivers.slice(0, 4).map(cg => (
                      <button key={(cg as any).id || cg.uid} onClick={() => setActiveTab('verification')} className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-50 transition-colors text-left mb-1">
                        <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center shrink-0">
                          <span className="text-primary-700 font-semibold text-xs">{cg.name?.charAt(0)}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-slate-900 text-sm truncate">{cg.name}</p>
                          <p className="text-xs text-slate-500">Needs verification review</p>
                        </div>
                        <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">Review</span>
                      </button>
                    ))}
                  </div>

                  {/* Intake Leads */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-slate-900 text-sm">Recent Leads</h3>
                      <button onClick={() => setActiveTab('intakes')} className="text-xs text-primary-600 hover:text-primary-700 font-medium">
                        View all →
                      </button>
                    </div>
                    {intakeLeads.length === 0 ? (
                      <div className="text-center py-6">
                        <FileText className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                        <p className="text-sm text-slate-400">No leads yet</p>
                      </div>
                    ) : intakeLeads.slice(0, 4).map(lead => (
                      <button key={lead.userId} onClick={() => setSelectedLead(lead)} className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-50 transition-colors text-left mb-1">
                        <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center shrink-0">
                          <span className="text-blue-700 font-semibold text-xs">{lead.contactName?.charAt(0)}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-slate-900 text-sm truncate">{lead.contactName}</p>
                          <p className="text-xs text-slate-500 truncate">{lead.careTypes?.slice(0, 2).join(', ')}</p>
                        </div>
                        <StatusBadge status={lead.status || 'pending'} />
                      </button>
                    ))}
                  </div>

                  {/* Open Tickets */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-slate-900 text-sm">Open Tickets</h3>
                      <button onClick={() => setActiveTab('tickets')} className="text-xs text-primary-600 hover:text-primary-700 font-medium">
                        View all →
                      </button>
                    </div>
                    {tickets.filter(t => t.status === 'open').length === 0 ? (
                      <div className="text-center py-6">
                        <MessageSquare className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                        <p className="text-sm text-slate-400">No open tickets</p>
                      </div>
                    ) : tickets.filter(t => t.status === 'open').slice(0, 4).map(t => (
                      <button key={t.id} onClick={() => setActiveTab('tickets')} className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-50 transition-colors text-left mb-1">
                        <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center shrink-0">
                          <MessageSquare className="w-4 h-4 text-slate-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-slate-900 text-sm truncate">{t.subject}</p>
                          <p className="text-xs text-slate-500 capitalize">{t.priority} priority</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ── INTAKE LEADS ─────────────────────────── */}
            {activeTab === 'intakes' && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="relative flex-1 max-w-sm">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="Search by name, email, or phone…"
                      className="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>
                  <button className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-white bg-white">
                    <Filter className="w-4 h-4" /> Filter
                  </button>
                  <button className="flex items-center gap-2 px-3 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
                    <Download className="w-4 h-4" /> Export
                  </button>
                </div>

                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        {['Contact', 'Care Recipient', 'Care Needs', 'Schedule', 'Status', ''].map(h => (
                          <th key={h} className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredLeads.map(lead => (
                        <tr key={lead.userId} className="hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 bg-primary-100 rounded-full flex items-center justify-center shrink-0">
                                <span className="text-primary-700 font-semibold text-sm">{lead.contactName?.charAt(0).toUpperCase()}</span>
                              </div>
                              <div>
                                <p className="font-medium text-slate-900 text-sm">{lead.contactName}</p>
                                <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5"><Phone className="w-3 h-3" />{lead.phone}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <p className="font-medium text-slate-900 text-sm">{lead.recipientName}</p>
                            <p className="text-xs text-slate-500">{lead.relationship} · {lead.city}, {lead.state}</p>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex flex-wrap gap-1">
                              {lead.careTypes?.slice(0, 2).map((t, i) => (
                                <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">{t}</span>
                              ))}
                              {(lead.careTypes?.length ?? 0) > 2 && (
                                <span className="px-2 py-0.5 bg-slate-100 text-slate-500 text-xs rounded">+{lead.careTypes!.length - 2}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <p className="text-sm text-slate-700">{lead.schedule}</p>
                            <p className="text-xs text-slate-400 mt-0.5">Start: {lead.startDate}</p>
                          </td>
                          <td className="px-5 py-3.5"><StatusBadge status={lead.status || 'pending'} /></td>
                          <td className="px-5 py-3.5 text-right">
                            <button onClick={() => setSelectedLead(lead)} className="text-primary-600 hover:text-primary-700 text-sm font-medium">Details</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredLeads.length === 0 && (
                    <div className="py-16 text-center">
                      <FileText className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-slate-400 text-sm">No intake leads found</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── FINANCE ─────────────────────────────── */}
            {activeTab === 'finance' && <InvoicingTab />}

            {/* ── TICKETS ──────────────────────────────── */}
            {activeTab === 'tickets' && (
              <TicketManager onShowToast={(msg, type) => { if (type === 'error') showToast(msg); }} />
            )}

            {/* ── SYSTEM ALERTS ────────────────────────── */}
            {activeTab === 'alerts' && (
              <AdminAlertsPanel onShowToast={(msg) => showToast(msg)} />
            )}

            {/* ── AUDIT LOG ────────────────────────────── */}
            {activeTab === 'audit' && <AuditTrail />}
          </div>
        )}
      </main>

      {/* ── Lead Detail Modal ────────────────────────────── */}
      {selectedLead && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto">
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900">Lead — {selectedLead.contactName}</h3>
              <button onClick={() => setSelectedLead(null)} className="p-1.5 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-500" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Contact', selectedLead.contactName],
                  ['Phone', selectedLead.phone],
                  ['Email', selectedLead.email],
                  ['Status', selectedLead.status || 'pending'],
                  ['Recipient', `${selectedLead.recipientName} (${selectedLead.relationship})`],
                  ['Location', `${selectedLead.city}, ${selectedLead.state}`],
                  ['Schedule', selectedLead.schedule],
                  ['Start Date', selectedLead.startDate],
                ].map(([label, val]) => (
                  <div key={label} className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs text-slate-400 uppercase font-semibold mb-0.5">{label}</p>
                    <p className="text-sm font-medium text-slate-900">{val}</p>
                  </div>
                ))}
              </div>
              {selectedLead.careTypes && selectedLead.careTypes.length > 0 && (
                <div>
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-2">Care Types</p>
                  <div className="flex flex-wrap gap-2">
                    {selectedLead.careTypes.map((t, i) => (
                      <span key={i} className="px-3 py-1 bg-primary-50 text-primary-700 text-sm rounded-full">{t}</span>
                    ))}
                  </div>
                </div>
              )}
              {selectedLead.additionalComments && (
                <div className="bg-slate-50 rounded-lg p-3">
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Notes</p>
                  <p className="text-sm text-slate-700">{selectedLead.additionalComments}</p>
                </div>
              )}
            </div>
            <div className="p-5 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setSelectedLead(null)} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">Close</button>
              {selectedLead.status === 'pending' && (
                <button onClick={() => handleMarkContacted(selectedLead.userId)} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700">
                  Mark Contacted
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {toastMsg && (
        <div className="fixed bottom-6 right-6 bg-slate-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50">{toastMsg}</div>
      )}
    </div>
  );
};

export default AdminView;
