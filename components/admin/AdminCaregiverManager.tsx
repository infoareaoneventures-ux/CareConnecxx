import React, { useState, useEffect, useRef } from 'react';
import {
  Search, Star, Shield, Edit2, Save, X, Ban, CheckCircle, Clock,
  Bell, RefreshCw, AlertCircle, Calendar, Tag, ChevronDown, ChevronUp,
  Users, FileText, ExternalLink, Car,
} from 'lucide-react';
import { adminService, dbService } from '../../services/api';
import { documentUploadService, DocumentType } from '../../services/documentUpload';
import { functions } from '../../lib/firebase';
import { Caregiver, Appointment } from '../../types';

type Panel = 'profile' | 'appointments' | 'verification';
type ModerationAction = 'ban' | 'unban' | 'suspend' | 'unsuspend' | 'notify' | null;
type ToastState = { msg: string; type: 'success' | 'error' } | null;

const SKILLS_OPTIONS = [
  'Driving', 'Meal Preparation', 'Medical Assistance', 'Companionship',
  'Personal Care', 'Housekeeping', 'Physical Therapy Support',
  'Dementia Care', 'Hospice Support', 'Overnight Care',
];

const VER_FILTERS = ['all', 'pending', 'submitted', 'approved', 'rejected'] as const;

export const AdminCaregiverManager: React.FC = () => {
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [verFilter, setVerFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Caregiver | null>(null);
  const [panel, setPanel] = useState<Panel>('profile');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Caregiver>>({});
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [apptLoading, setApptLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  // Moderation inline state
  const [moderationAction, setModerationAction] = useState<ModerationAction>(null);
  const [suspendDays, setSuspendDays] = useState(7);
  const [suspendReason, setSuspendReason] = useState('');
  const [notifyMessage, setNotifyMessage] = useState('');
  const [moderating, setModerating] = useState(false);

  // Verification
  const [rejectReason, setRejectReason] = useState('');
  const [approveBackground, setApproveBackground] = useState(false);
  const [approveMembership, setApproveMembership] = useState(false);
  const [docExpiry, setDocExpiry] = useState<Record<string, string>>({});
  const [docProcessing, setDocProcessing] = useState<Record<string, boolean>>({});
  const [docRejectNote, setDocRejectNote] = useState<Record<string, string>>({});
  const [docRejectOpen, setDocRejectOpen] = useState<Record<string, boolean>>({});
  const [docReviseOpen, setDocReviseOpen] = useState<Record<string, boolean>>({});

  // Skills dropdown
  const [showSkillsDropdown, setShowSkillsDropdown] = useState(false);
  const skillsRef = useRef<HTMLDivElement>(null);

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!showSkillsDropdown) return;
    const handler = (e: MouseEvent) => {
      if (skillsRef.current && !skillsRef.current.contains(e.target as Node)) {
        setShowSkillsDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSkillsDropdown]);

  const load = async () => {
    setLoading(true);
    try {
      const all = await adminService.getAllCaregivers();
      setCaregivers(all);
      if (all.length === 0) console.warn('[AdminCaregiverManager] getAllCaregivers returned 0 results');
    } catch (err) {
      console.error('[AdminCaregiverManager] Failed to load caregivers:', err);
      showToast('Failed to load caregivers', 'error');
    } finally {
      setLoading(false);
    }
  };

  const openCaregiver = async (c: Caregiver) => {
    setSelected(c);
    setForm({
      name: c.name, email: c.email, phone: c.phone, bio: c.bio,
      hourlyRate: c.hourlyRate, experience: c.experience, location: c.location,
      skills: c.skills ? [...c.skills] : [],
      certifications: c.certifications ? [...c.certifications] : [],
      gender: c.gender,
      languages: c.languages ? [...c.languages] : [],
    });
    setEditing(false);
    setPanel('profile');
    setModerationAction(null);
    setRejectReason('');
    setNotifyMessage('');
    setSuspendReason('');
    setSuspendDays(7);

    if (!c.email && c.uid) {
      const email = await adminService.getUserEmail(c.uid);
      if (email) {
        setSelected(prev => prev ? { ...prev, email } : prev);
        setForm(prev => ({ ...prev, email }));
      }
    }
  };

  const loadAppointments = async (cid: string) => {
    setApptLoading(true);
    try {
      const appts = await adminService.getCaregiverAppointments(cid);
      setAppointments(appts);
    } finally {
      setApptLoading(false);
    }
  };

  const handlePanelSwitch = (p: Panel) => {
    setPanel(p);
    if (p === 'appointments' && selected) loadAppointments(selected.uid);
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await adminService.updateCaregiver(selected.uid, form);
      setCaregivers(prev => prev.map(c => c.uid === selected.uid ? { ...c, ...form } as Caregiver : c));
      setSelected(prev => prev ? { ...prev, ...form } as Caregiver : prev);
      setEditing(false);
      showToast('Caregiver updated', 'success');
    } catch {
      showToast('Failed to save changes', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async (status: 'approved' | 'rejected' | 'info_requested') => {
    if (!selected) return;
    if (status === 'rejected' && !rejectReason) { showToast('Enter a rejection reason', 'error'); return; }
    try {
      const updates: Partial<Caregiver> = {};
      if (status === 'approved') {
        if (!approveBackground && !approveMembership) {
          showToast('Select at least one item to approve', 'error');
          return;
        }
        if (approveBackground) {
          (updates as any).backgroundCheckStatus = 'clear';
          (updates as any).backgroundCheckComplete = true;
          (updates as any).verified = true;
          (updates as any).verificationStatus = 'approved';
        }
        if (approveMembership) {
          (updates as any).membershipPaid = true;
          (updates as any).membershipStatus = 'active';
        }
      }
      if (status === 'rejected') { (updates as any).verificationStatus = 'rejected'; updates.verified = false; (updates as any).rejectionReason = rejectReason; }
      if (status === 'info_requested') { (updates as any).verificationStatus = 'info_requested'; updates.verified = false; }
      await adminService.updateCaregiver(selected.uid, updates);
      setCaregivers(prev => prev.map(c => c.uid === selected.uid ? { ...c, ...updates } as Caregiver : c));
      setSelected(prev => prev ? { ...prev, ...updates } as Caregiver : prev);
      showToast(`Caregiver ${status}`, 'success');
      dbService.sendNotification(selected.uid, {
        type: `verification_${status}` as any,
        title: status === 'approved' ? "You're Verified!" : status === 'rejected' ? 'Verification Update' : 'Additional Info Needed',
        body: status === 'approved' ? 'Your background check has been approved.' : status === 'rejected' ? `Not approved. Reason: ${rejectReason}` : 'We need more information to complete your verification.',
        message: '',
        userId: selected.uid,
        isRead: false,
      }).catch((err) => {
        console.error('[AdminCaregiverManager] Failed to send notification:', err);
        showToast('Notification to caregiver failed', 'error');
      });
    } catch {
      showToast('Failed to update verification', 'error');
    }
  };

  const handleBan = async () => {
    if (!selected) return;
    setModerating(true);
    try {
      await dbService.banUser(selected.uid);
      const patch = { isBanned: true } as any;
      setCaregivers(prev => prev.map(c => c.uid === selected.uid ? { ...c, ...patch } : c));
      setSelected(prev => prev ? { ...prev, ...patch } as Caregiver : prev);
      setModerationAction(null);
      showToast(`${selected.name} banned`, 'success');
    } catch {
      showToast('Failed to ban caregiver', 'error');
    } finally {
      setModerating(false);
    }
  };

  const handleUnban = async () => {
    if (!selected) return;
    setModerating(true);
    try {
      await adminService.unbanUser(selected.uid);
      const patch = { isBanned: false } as any;
      setCaregivers(prev => prev.map(c => c.uid === selected.uid ? { ...c, ...patch } : c));
      setSelected(prev => prev ? { ...prev, ...patch } as Caregiver : prev);
      setModerationAction(null);
      showToast(`${selected.name} unbanned`, 'success');
    } catch {
      showToast('Failed to unban caregiver', 'error');
    } finally {
      setModerating(false);
    }
  };

  const handleSuspend = async () => {
    if (!selected || !suspendReason) return;
    setModerating(true);
    try {
      await adminService.suspendUser(selected.uid, suspendReason, suspendDays);
      const patch = { isSuspended: true } as any;
      setCaregivers(prev => prev.map(c => c.uid === selected.uid ? { ...c, ...patch } : c));
      setSelected(prev => prev ? { ...prev, ...patch } as Caregiver : prev);
      setModerationAction(null);
      setSuspendReason('');
      showToast(`${selected.name} suspended for ${suspendDays} days`, 'success');
    } catch {
      showToast('Failed to suspend caregiver', 'error');
    } finally {
      setModerating(false);
    }
  };

  const handleUnsuspend = async () => {
    if (!selected) return;
    setModerating(true);
    try {
      await adminService.unsuspendUser(selected.uid);
      const patch = { isSuspended: false } as any;
      setCaregivers(prev => prev.map(c => c.uid === selected.uid ? { ...c, ...patch } : c));
      setSelected(prev => prev ? { ...prev, ...patch } as Caregiver : prev);
      setModerationAction(null);
      showToast(`${selected.name} unsuspended`, 'success');
    } catch {
      showToast('Failed to unsuspend caregiver', 'error');
    } finally {
      setModerating(false);
    }
  };

  const handleNotify = async () => {
    if (!selected || !notifyMessage.trim()) return;
    setModerating(true);
    try {
      await dbService.sendNotification(selected.uid, {
        type: 'admin_message', title: 'Message from CareConnex',
        body: notifyMessage, message: notifyMessage,
        userId: selected.uid, isRead: false,
      });
      setNotifyMessage('');
      setModerationAction(null);
      showToast('Notification sent', 'success');
    } catch {
      showToast('Failed to send notification', 'error');
    } finally {
      setModerating(false);
    }
  };

  const toggleSkill = (skill: string) => {
    setForm(prev => {
      const skills = prev.skills ? [...prev.skills] : [];
      return { ...prev, skills: skills.includes(skill) ? skills.filter(s => s !== skill) : [...skills, skill] };
    });
  };

  const handleDocAction = async (docType: DocumentType, action: 'approved' | 'rejected') => {
    if (!selected) return;
    const note = docRejectNote[docType] || undefined;
    setDocProcessing(prev => ({ ...prev, [docType]: true }));
    try {
      await documentUploadService.updateDocumentStatus(
        selected.uid, docType, action, note, 'admin', docExpiry[docType] || undefined,
      );
      setDocRejectOpen(prev => ({ ...prev, [docType]: false }));
      setDocRejectNote(prev => ({ ...prev, [docType]: '' }));
      setDocReviseOpen(prev => ({ ...prev, [docType]: false }));
      setSelected(prev => {
        if (!prev) return prev;
        const docs = { ...(prev.documents || {}), [docType]: { ...(prev.documents as any)?.[docType], status: action } };
        return { ...prev, documents: docs } as Caregiver;
      });
      showToast(`${docType} ${action}`, 'success');
      // Immediately recalculate transportation badge
      try {
        const refreshBadge = functions?.httpsCallable('v1-refreshTransportBadge');
        if (refreshBadge) await refreshBadge({ uid: selected.uid });
      } catch (err) {
        console.warn('Could not refresh transport badge:', err);
      }
    } catch (err: any) {
      showToast(err?.message || 'Failed to update document', 'error');
    } finally {
      setDocProcessing(prev => ({ ...prev, [docType]: false }));
    }
  };

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const verStatusColor = (v?: string) => {
    if (v === 'approved') return 'bg-green-100 text-green-700';
    if (v === 'rejected') return 'bg-red-100 text-red-700';
    if (v === 'submitted') return 'bg-yellow-100 text-yellow-700';
    if (v === 'info_requested') return 'bg-orange-100 text-orange-700';
    return 'bg-slate-100 text-slate-600';
  };

  const filtered = caregivers.filter(c => {
    const matchSearch = !search || c.name?.toLowerCase().includes(search.toLowerCase()) || c.email?.toLowerCase().includes(search.toLowerCase());
    const matchVer = verFilter === 'all' || c.verificationStatus === verFilter || (verFilter === 'pending' && (!c.verificationStatus || c.verificationStatus === 'info_requested'));
    return matchSearch && matchVer;
  });

  return (
    <div className="flex h-full">
      {/* List pane */}
      <div className={`${selected ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-80 border-r border-slate-200 bg-white shrink-0`}>
        <div className="p-4 border-b border-slate-100 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search caregivers…" className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>
          <div className="flex gap-1 flex-wrap">
            {VER_FILTERS.map(f => (
              <button key={f} onClick={() => setVerFilter(f)} className={`px-2.5 py-1 text-xs rounded-full font-medium capitalize transition-colors ${verFilter === f ? 'bg-primary-100 text-primary-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>{f}</button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-slate-400">
              <Users className="w-10 h-10 mb-2" />
              <p className="text-sm">No caregivers found</p>
            </div>
          ) : filtered.map(c => (
            <button
              key={c.uid}
              onClick={() => openCaregiver(c)}
              className={`w-full text-left flex items-center gap-3 px-4 py-3 border-b border-slate-50 hover:bg-slate-50 transition-colors ${selected?.uid === c.uid ? 'bg-primary-50 border-l-2 border-l-primary-500' : ''}`}
            >
              <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center shrink-0">
                <span className="text-primary-700 font-semibold text-sm">{c.name?.charAt(0).toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-900 text-sm truncate">{c.name}</p>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>${c.hourlyRate}/hr</span>
                  {c.rating != null && (
                    <span className="flex items-center gap-0.5"><Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />{c.rating.toFixed(1)}</span>
                  )}
                </div>
              </div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 capitalize ${verStatusColor(c.verificationStatus)}`}>{c.verificationStatus || 'pending'}</span>
            </button>
          ))}
        </div>

        <div className="p-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-400">{filtered.length} of {caregivers.length} caregivers</span>
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* Detail pane */}
      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden bg-white min-w-0">
          {/* Header */}
          <div className="flex items-center gap-4 px-6 py-4 border-b border-slate-200">
            <button onClick={() => setSelected(null)} className="lg:hidden p-1 rounded hover:bg-slate-100"><X className="w-5 h-5" /></button>
            <div className="w-12 h-12 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-lg shrink-0">
              {selected.name?.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="font-bold text-slate-900 text-lg truncate">{selected.name}</h2>
              <p className="text-sm text-slate-500 truncate">{selected.email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(selected as any).isBanned && <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-100 text-red-700">Banned</span>}
              {(selected as any).isSuspended && <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-orange-100 text-orange-700">Suspended</span>}
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${verStatusColor(selected.verificationStatus)}`}>{selected.verificationStatus || 'pending'}</span>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-200 px-6">
            {(['profile', 'appointments', 'verification'] as Panel[]).map(p => (
              <button key={p} onClick={() => handlePanelSwitch(p)} className={`px-4 py-3 text-sm font-medium capitalize border-b-2 transition-colors ${panel === p ? 'border-primary-600 text-primary-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{p}</button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {/* PROFILE */}
            {panel === 'profile' && (
              <>
                {/* Profile form */}
                <div className="bg-slate-50 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-slate-900">Profile Information</h3>
                    {!editing ? (
                      <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 font-medium"><Edit2 className="w-4 h-4" /> Edit</button>
                    ) : (
                      <div className="flex gap-2">
                        <button onClick={() => setEditing(false)} className="text-sm text-slate-500 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-white">Cancel</button>
                        <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 text-sm text-white bg-primary-600 px-3 py-1.5 rounded-lg font-medium hover:bg-primary-700 disabled:opacity-50"><Save className="w-3.5 h-3.5" />{saving ? 'Saving…' : 'Save'}</button>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { label: 'Full Name', key: 'name' },
                      { label: 'Email', key: 'email' },
                      { label: 'Phone', key: 'phone' },
                      { label: 'Location', key: 'location' },
                      { label: 'Hourly Rate ($)', key: 'hourlyRate', type: 'number' },
                      { label: 'Years Experience', key: 'experience', type: 'number' },
                      { label: 'Gender', key: 'gender' },
                    ].map(({ label, key, type }) => (
                      <div key={key}>
                        <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
                        {editing ? (
                          <input
                            type={type || 'text'}
                            value={(form as any)[key] ?? ''}
                            onChange={e => setForm(prev => ({ ...prev, [key]: type === 'number' ? Number(e.target.value) : e.target.value }))}
                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                          />
                        ) : (
                          <p className="text-sm text-slate-900">{(selected as any)[key] != null ? (selected as any)[key] : <span className="text-slate-400 italic">Not set</span>}</p>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="mt-4">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Bio</label>
                    {editing ? (
                      <textarea value={form.bio || ''} onChange={e => setForm(prev => ({ ...prev, bio: e.target.value }))} rows={3} className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none bg-white" />
                    ) : (
                      <p className="text-sm text-slate-700 leading-relaxed">{selected.bio || <span className="text-slate-400 italic">No bio</span>}</p>
                    )}
                  </div>

                  <div className="mt-4">
                    <label className="flex items-center gap-1 text-xs font-medium text-slate-500 mb-2"><Tag className="w-3 h-3" /> Skills</label>
                    {editing ? (
                      <div className="relative" ref={skillsRef}>
                        <button
                          type="button"
                          onClick={() => setShowSkillsDropdown(v => !v)}
                          className="flex items-center gap-2 px-3 py-2 text-sm border border-slate-200 rounded-lg w-full justify-between bg-white hover:border-slate-300"
                        >
                          <span className="truncate text-slate-700">{form.skills?.length ? form.skills.join(', ') : 'Select skills'}</span>
                          {showSkillsDropdown ? <ChevronUp className="w-4 h-4 shrink-0 text-slate-400" /> : <ChevronDown className="w-4 h-4 shrink-0 text-slate-400" />}
                        </button>
                        {showSkillsDropdown && (
                          <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
                            {SKILLS_OPTIONS.map(s => (
                              <label key={s} className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-slate-50 cursor-pointer text-sm text-slate-700">
                                <input type="checkbox" checked={form.skills?.includes(s) || false} onChange={() => toggleSkill(s)} className="rounded accent-primary-600" />
                                {s}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {selected.skills?.length ? selected.skills.map(s => (
                          <span key={s} className="px-2.5 py-0.5 bg-primary-50 text-primary-700 text-xs rounded-full font-medium">{s}</span>
                        )) : <span className="text-slate-400 text-sm italic">None listed</span>}
                      </div>
                    )}
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-slate-50 rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-slate-900">{selected.rating?.toFixed(1) || '—'}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Avg Rating</p>
                  </div>
                  <div className="bg-slate-50 rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-slate-900">{selected.completedJobs || 0}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Jobs Done</p>
                  </div>
                  <div className="bg-slate-50 rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-slate-900">${(selected.totalEarnings || 0).toLocaleString()}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Earnings</p>
                  </div>
                </div>

                {/* Moderation */}
                <div className="bg-slate-50 rounded-xl p-5">
                  <h3 className="font-semibold text-slate-900 mb-3">Moderation</h3>

                  {/* Inline notify */}
                  {moderationAction === 'notify' && (
                    <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
                      <p className="text-sm font-medium text-blue-800">Send Notification to {selected.name}</p>
                      <textarea
                        value={notifyMessage}
                        onChange={e => setNotifyMessage(e.target.value)}
                        placeholder="Type your message…"
                        rows={3}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                      />
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setModerationAction(null)} className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-white">Cancel</button>
                        <button onClick={handleNotify} disabled={!notifyMessage.trim() || moderating} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">{moderating ? 'Sending…' : 'Send'}</button>
                      </div>
                    </div>
                  )}

                  {/* Inline suspend form */}
                  {moderationAction === 'suspend' && (
                    <div className="mb-4 p-4 bg-orange-50 border border-orange-200 rounded-xl space-y-3">
                      <p className="text-sm font-medium text-orange-800">Suspend {selected.name}</p>
                      <textarea
                        value={suspendReason}
                        onChange={e => setSuspendReason(e.target.value)}
                        placeholder="Reason for suspension…"
                        rows={2}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                      />
                      <div className="flex items-center gap-3">
                        <label className="text-xs text-slate-600">Duration:</label>
                        <input type="number" value={suspendDays} onChange={e => setSuspendDays(Number(e.target.value))} min={1} max={365} className="w-20 px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white" />
                        <span className="text-sm text-slate-500">days</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-orange-700 bg-orange-100 rounded-lg px-3 py-2">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        Caregiver will be notified and lose access for {suspendDays} day{suspendDays !== 1 ? 's' : ''}.
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setModerationAction(null)} className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-white">Cancel</button>
                        <button onClick={handleSuspend} disabled={!suspendReason.trim() || moderating} className="px-3 py-1.5 text-sm bg-orange-600 text-white rounded-lg font-medium hover:bg-orange-700 disabled:opacity-50">{moderating ? 'Suspending…' : 'Confirm Suspend'}</button>
                      </div>
                    </div>
                  )}

                  {/* Inline ban confirm */}
                  {moderationAction === 'ban' && (
                    <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl space-y-3">
                      <p className="text-sm font-medium text-red-800">Ban {selected.name}?</p>
                      <p className="text-sm text-red-700">This will permanently revoke platform access. This action can be reversed by an admin.</p>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setModerationAction(null)} className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-white">Cancel</button>
                        <button onClick={handleBan} disabled={moderating} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50">{moderating ? 'Banning…' : 'Confirm Ban'}</button>
                      </div>
                    </div>
                  )}

                  {/* Inline unban confirm */}
                  {moderationAction === 'unban' && (
                    <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-xl space-y-3">
                      <p className="text-sm font-medium text-green-800">Unban {selected.name}?</p>
                      <p className="text-sm text-green-700">They will regain full platform access immediately.</p>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setModerationAction(null)} className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-white">Cancel</button>
                        <button onClick={handleUnban} disabled={moderating} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50">{moderating ? 'Unbanning…' : 'Confirm Unban'}</button>
                      </div>
                    </div>
                  )}

                  {/* Inline unsuspend confirm */}
                  {moderationAction === 'unsuspend' && (
                    <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-xl space-y-3">
                      <p className="text-sm font-medium text-green-800">Unsuspend {selected.name}?</p>
                      <p className="text-sm text-green-700">Their account will be restored immediately.</p>
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setModerationAction(null)} className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-white">Cancel</button>
                        <button onClick={handleUnsuspend} disabled={moderating} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50">{moderating ? 'Unsuspending…' : 'Confirm Unsuspend'}</button>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setModerationAction(moderationAction === 'notify' ? null : 'notify')}
                      className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-slate-200 hover:bg-white text-slate-700 transition-colors"
                    >
                      <Bell className="w-4 h-4" /> Notify
                    </button>
                    {(selected as any).isSuspended ? (
                      <button onClick={() => setModerationAction(moderationAction === 'unsuspend' ? null : 'unsuspend')} className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-green-300 text-green-700 hover:bg-green-50 transition-colors">
                        <CheckCircle className="w-4 h-4" /> Unsuspend
                      </button>
                    ) : (
                      <button onClick={() => setModerationAction(moderationAction === 'suspend' ? null : 'suspend')} className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-orange-300 text-orange-700 hover:bg-orange-50 transition-colors">
                        <Clock className="w-4 h-4" /> Suspend
                      </button>
                    )}
                    {(selected as any).isBanned ? (
                      <button onClick={() => setModerationAction(moderationAction === 'unban' ? null : 'unban')} className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-green-300 text-green-700 hover:bg-green-50 transition-colors">
                        <CheckCircle className="w-4 h-4" /> Unban
                      </button>
                    ) : (
                      <button onClick={() => setModerationAction(moderationAction === 'ban' ? null : 'ban')} className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-red-300 text-red-700 hover:bg-red-50 transition-colors">
                        <Ban className="w-4 h-4" /> Ban
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* APPOINTMENTS */}
            {panel === 'appointments' && (
              <div>
                {apptLoading ? (
                  <div className="flex items-center justify-center py-12 text-slate-400 text-sm">Loading…</div>
                ) : appointments.length === 0 ? (
                  <div className="flex flex-col items-center py-16 text-slate-400">
                    <Calendar className="w-10 h-10 mb-2" />
                    <p className="text-sm">No appointments found</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {appointments.map(a => (
                      <div key={a.id} className="bg-slate-50 rounded-xl p-4 flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-slate-900 text-sm">{a.clientName}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{a.date} at {a.time} · {a.duration}h</p>
                          <p className="text-xs text-slate-500">${a.cost} · {a.paymentStatus}</p>
                        </div>
                        <span className={`text-xs font-medium px-2.5 py-1 rounded-full shrink-0 ${a.status === 'completed' ? 'bg-green-100 text-green-700' : a.status === 'cancelled' ? 'bg-red-100 text-red-700' : a.status === 'in-progress' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{a.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* VERIFICATION */}
            {panel === 'verification' && (
              <>
                <div className="bg-slate-50 rounded-xl p-5">
                  <h3 className="font-semibold text-slate-900 mb-4 flex items-center gap-2"><Shield className="w-4 h-4 text-primary-600" /> Verification Status</h3>
                  <div className="flex items-center gap-3 mb-4 flex-wrap">
                    <span className={`text-sm font-medium px-3 py-1.5 rounded-full capitalize ${verStatusColor(selected.verificationStatus)}`}>{selected.verificationStatus || 'Not submitted'}</span>
                    {selected.approvedAt && <span className="text-xs text-slate-500">Approved {new Date(selected.approvedAt).toLocaleDateString()}</span>}
                    {(selected as any).rejectedAt && <span className="text-xs text-slate-500">Rejected {new Date((selected as any).rejectedAt).toLocaleDateString()}</span>}
                  </div>
                  {(selected as any).rejectionReason && (
                    <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 rounded-lg p-3 mb-4">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{(selected as any).rejectionReason}</span>
                    </div>
                  )}

                  {/* Field overrides */}
                  <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Field Overrides</p>
                    <div className="space-y-2">
                      {/* Membership */}
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-700">Membership payment</span>
                        <div className="flex gap-2">
                          <button
                            onClick={async () => { await adminService.updateCaregiver(selected.uid, { membershipPaid: true, membershipStatus: 'active' } as any); setSelected(p => p ? { ...p, membershipPaid: true, membershipStatus: 'active' } as any : p); showToast('Membership approved', 'success'); }}
                            className={`text-xs px-3 py-1 rounded-lg font-medium border transition-colors ${(selected as any).membershipPaid ? 'bg-green-100 text-green-700 border-green-200' : 'bg-white text-slate-500 border-slate-200 hover:bg-green-50'}`}
                          >Approved</button>
                          <button
                            onClick={async () => { await adminService.updateCaregiver(selected.uid, { membershipPaid: false, membershipStatus: 'inactive' } as any); setSelected(p => p ? { ...p, membershipPaid: false, membershipStatus: 'inactive' } as any : p); showToast('Membership revoked', 'success'); }}
                            className={`text-xs px-3 py-1 rounded-lg font-medium border transition-colors ${!(selected as any).membershipPaid ? 'bg-red-100 text-red-700 border-red-200' : 'bg-white text-slate-500 border-slate-200 hover:bg-red-50'}`}
                          >Revoked</button>
                        </div>
                      </div>
                      {/* Background check */}
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-700">Background check</span>
                        <div className="flex gap-2">
                          <button
                            onClick={async () => { await adminService.updateCaregiver(selected.uid, { backgroundCheckStatus: 'clear', backgroundCheckComplete: true, verified: true, verificationStatus: 'approved' } as any); setSelected(p => p ? { ...p, backgroundCheckStatus: 'clear', backgroundCheckComplete: true, verified: true, verificationStatus: 'approved' } as any : p); showToast('Background check approved', 'success'); }}
                            className={`text-xs px-3 py-1 rounded-lg font-medium border transition-colors ${(selected as any).backgroundCheckStatus === 'clear' ? 'bg-green-100 text-green-700 border-green-200' : 'bg-white text-slate-500 border-slate-200 hover:bg-green-50'}`}
                          >Approved</button>
                          <button
                            onClick={async () => { await adminService.updateCaregiver(selected.uid, { backgroundCheckStatus: 'pending', backgroundCheckComplete: false, verified: false, verificationStatus: 'pending' } as any); setSelected(p => p ? { ...p, backgroundCheckStatus: 'pending', backgroundCheckComplete: false, verified: false, verificationStatus: 'pending' } as any : p); showToast('Background check revoked', 'success'); }}
                            className={`text-xs px-3 py-1 rounded-lg font-medium border transition-colors ${(selected as any).backgroundCheckStatus !== 'clear' ? 'bg-red-100 text-red-700 border-red-200' : 'bg-white text-slate-500 border-slate-200 hover:bg-red-50'}`}
                          >Revoked</button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {selected.backgroundCheckData && (
                    <div className="grid grid-cols-2 gap-3 bg-white rounded-xl p-4 text-sm">
                      {[
                        { label: 'Legal Name', value: `${selected.backgroundCheckData.legalFirstName} ${selected.backgroundCheckData.legalLastName}` },
                        { label: 'Date of Birth', value: selected.backgroundCheckData.dob },
                        { label: 'SSN Last 4', value: `***-**-${selected.backgroundCheckData.ssnLastFour}` },
                        { label: 'ZIP Code', value: selected.backgroundCheckData.zip },
                        { label: 'Consent', value: selected.backgroundCheckData.consentGiven ? '✓ Given' : 'Not given' },
                        ...(selected.backgroundCheckData.checkrCandidateId ? [{ label: 'Checkr ID', value: selected.backgroundCheckData.checkrCandidateId }] : []),
                      ].map(({ label, value }) => (
                        <div key={label}>
                          <span className="text-xs text-slate-500 block mb-0.5">{label}</span>
                          <p className="font-medium text-slate-900 text-sm">{value}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Checkr Background Check Result */}
                {selected.backgroundCheckData && (
                  <div className="bg-slate-50 rounded-xl p-5">
                    <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
                      <Shield className="w-4 h-4 text-primary-600" /> Background Check Result
                    </h3>
                    {(!(selected.backgroundCheckData as any).status || (selected.backgroundCheckData as any).status === 'pending') ? (
                      <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                        <Clock className="w-4 h-4 shrink-0" />
                        <span>Awaiting result from Checkr.</span>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-3 mb-3 flex-wrap">
                          <span className={`text-sm font-bold px-3 py-1.5 rounded-full uppercase tracking-wide ${
                            (selected.backgroundCheckData as any).status === 'clear' ? 'bg-green-100 text-green-700' :
                            (selected.backgroundCheckData as any).status === 'consider' ? 'bg-orange-100 text-orange-700' :
                            (selected.backgroundCheckData as any).status === 'suspended' ? 'bg-red-100 text-red-700' :
                            (selected.backgroundCheckData as any).status === 'canceled' ? 'bg-slate-100 text-slate-500' :
                            'bg-yellow-100 text-yellow-700'
                          }`}>
                            {(selected.backgroundCheckData as any).status}
                          </span>
                          {(selected.backgroundCheckData as any).disputed && (
                            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">Disputed</span>
                          )}
                          {(selected.backgroundCheckData as any).completedAt && (
                            <span className="text-xs text-slate-500">
                              Completed {new Date((selected.backgroundCheckData as any).completedAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-3 bg-white rounded-xl p-4 text-sm">
                          {[
                            ...(selected.backgroundCheckData.legalFirstName ? [{ label: 'Legal Name', value: `${selected.backgroundCheckData.legalFirstName} ${selected.backgroundCheckData.legalLastName}` }] : []),
                            ...(selected.backgroundCheckData.dob ? [{ label: 'Date of Birth', value: selected.backgroundCheckData.dob }] : []),
                            ...(selected.backgroundCheckData.ssnLastFour ? [{ label: 'SSN Last 4', value: `***-**-${selected.backgroundCheckData.ssnLastFour}` }] : []),
                            ...(selected.backgroundCheckData.checkrCandidateId ? [{ label: 'Candidate ID', value: selected.backgroundCheckData.checkrCandidateId }] : []),
                            ...((selected.backgroundCheckData as any).checkrReportId ? [{ label: 'Report ID', value: (selected.backgroundCheckData as any).checkrReportId }] : []),
                            ...(selected.backgroundCheckData.invitationStatus ? [{ label: 'Invitation', value: selected.backgroundCheckData.invitationStatus }] : []),
                          ].map(({ label, value }) => (
                            <div key={label}>
                              <span className="text-xs text-slate-500 block mb-0.5">{label}</span>
                              <p className="font-medium text-slate-900 text-sm break-all">{value}</p>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Uploaded Documents */}
                {(() => {
                  const docs = selected.documents as any;
                  const REQUIRES_EXPIRY: DocumentType[] = ['driversLicense', 'driversLicenseBack', 'insurance', 'registration'];
                  const docList: { key: DocumentType; label: string }[] = (
                    [
                      { key: 'driversLicense' as DocumentType, label: "Driver's License (Front)" },
                      { key: 'driversLicenseBack' as DocumentType, label: "Driver's License (Back)" },
                      { key: 'insurance' as DocumentType, label: 'Vehicle Insurance' },
                      { key: 'registration' as DocumentType, label: 'Vehicle Registration' },
                    ] as { key: DocumentType; label: string }[]
                  ).filter(d => docs?.[d.key]);
                  if (!docList.length) return null;
                  return (
                    <div className="bg-slate-50 rounded-xl p-5 space-y-3">
                      <h3 className="font-semibold text-slate-900 flex items-center gap-2"><Car className="w-4 h-4 text-primary-600" /> Uploaded Documents</h3>
                      {docList.map(({ key, label }) => {
                        const doc = docs[key];
                        const processing = docProcessing[key];
                        const _today = new Date(); _today.setHours(0,0,0,0);
                        const isExpired = doc.expirationDate && (() => { const [ey,em,ed] = doc.expirationDate.split('-'); return new Date(+ey,+em-1,+ed); })() < _today;
                        const isPending = !doc.status || doc.status === 'pending' || (doc.status === 'approved' && isExpired);
                        return (
                          <div key={key} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
                            <div className="flex items-center gap-3">
                              <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                              <span className="flex-1 text-sm font-medium text-slate-700">{label}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                doc.status === 'approved' && isExpired ? 'bg-orange-100 text-orange-700'
                                : doc.status === 'approved' ? 'bg-teal-100 text-teal-700'
                                : doc.status === 'rejected' ? 'bg-red-100 text-red-700'
                                : 'bg-amber-100 text-amber-700'
                              }`}>{doc.status === 'approved' && isExpired ? 'expired' : (doc.status || 'pending')}</span>
                              <a href={doc.url} target="_blank" rel="noopener noreferrer"
                                className="text-xs text-primary-600 hover:underline flex items-center gap-0.5">
                                View <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                            {(isPending || docReviseOpen[key]) && (() => {
                              const needsExpiry = REQUIRES_EXPIRY.includes(key);
                              const hasExpiry = !!docExpiry[key];
                              const canApprove = !needsExpiry || hasExpiry;
                              const rejectOpen = docRejectOpen[key];
                              return (
                                <div className="flex flex-col gap-2 pl-7">
                                  {needsExpiry && (
                                    <div className="flex items-center gap-2">
                                      <label className="text-xs text-slate-500 whitespace-nowrap">
                                        Expiry date <span className="text-red-500">*</span>
                                      </label>
                                      <input type="date" value={docExpiry[key] || ''}
                                        onChange={e => setDocExpiry(prev => ({ ...prev, [key]: e.target.value }))}
                                        className="flex-1 text-xs px-2 py-1 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400" />
                                    </div>
                                  )}
                                  <div className="flex gap-2">
                                    <button
                                      onClick={() => handleDocAction(key, 'approved')}
                                      disabled={processing || !canApprove}
                                      title={!canApprove ? 'Enter expiry date before approving' : ''}
                                      className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 px-3 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
                                      <CheckCircle className="w-3 h-3" /> Approve
                                    </button>
                                    <button
                                      onClick={() => setDocRejectOpen(prev => ({ ...prev, [key]: !rejectOpen }))}
                                      disabled={processing}
                                      className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 px-3 py-1.5 rounded-lg disabled:opacity-50">
                                      <X className="w-3 h-3" /> Reject
                                    </button>
                                  </div>
                                  {rejectOpen && (
                                    <div className="flex flex-col gap-1.5">
                                      <textarea
                                        value={docRejectNote[key] || ''}
                                        onChange={e => setDocRejectNote(prev => ({ ...prev, [key]: e.target.value }))}
                                        placeholder="Reason for rejection (shown to caregiver)…"
                                        rows={2}
                                        className="w-full text-xs px-2 py-1.5 border border-red-200 rounded-lg focus:outline-none focus:border-red-400 resize-none"
                                      />
                                      <button
                                        onClick={() => handleDocAction(key, 'rejected')}
                                        disabled={processing || !docRejectNote[key]?.trim()}
                                        className="flex items-center justify-center gap-1 text-xs font-semibold bg-red-600 text-white px-3 py-1.5 rounded-lg disabled:opacity-50">
                                        Confirm Reject
                                      </button>
                                    </div>
                                  )}
                                  {docReviseOpen[key] && !isPending && (
                                    <button
                                      onClick={() => { setDocReviseOpen(prev => ({ ...prev, [key]: false })); setDocRejectOpen(prev => ({ ...prev, [key]: false })); }}
                                      className="text-xs text-slate-400 hover:text-slate-600 underline text-left"
                                    >
                                      Cancel
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                            {doc.status === 'approved' && !isExpired && !docReviseOpen[key] && (
                              <div className="pl-7">
                                <button
                                  onClick={() => setDocReviseOpen(prev => ({ ...prev, [key]: true }))}
                                  className="text-xs text-slate-400 hover:text-primary-600 underline font-medium"
                                >
                                  Revise decision
                                </button>
                              </div>
                            )}
                            {doc.expirationDate && (
                              <p className={`pl-7 text-xs font-medium ${isExpired ? 'text-orange-600' : 'text-slate-500'}`}>
                                {isExpired ? 'Expired: ' : 'Expires: '}{new Date(doc.expirationDate).toLocaleDateString()}
                                {isExpired && ' — re-enter expiry date to renew'}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                <div className="bg-slate-50 rounded-xl p-5 space-y-4">
                  <h3 className="font-semibold text-slate-900">Review Decision</h3>
                  <textarea
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                    placeholder="Notes / rejection reason (required to reject)"
                    rows={3}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                  />
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Approve selected items</p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={approveBackground} onChange={e => setApproveBackground(e.target.checked)} className="w-4 h-4 rounded accent-green-600" />
                      <span className="text-sm text-slate-700">Background check</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={approveMembership} onChange={e => setApproveMembership(e.target.checked)} className="w-4 h-4 rounded accent-green-600" />
                      <span className="text-sm text-slate-700">Membership payment</span>
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <button onClick={() => handleVerify('approved')} className="flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 transition-colors">
                      <CheckCircle className="w-4 h-4" /> Approve
                    </button>
                    <button onClick={() => handleVerify('info_requested')} className="px-4 py-2.5 border border-orange-300 text-orange-700 rounded-xl text-sm font-medium hover:bg-orange-50 transition-colors">
                      Request Info
                    </button>
                    <button onClick={() => handleVerify('rejected')} className="flex items-center justify-center gap-2 px-4 py-2.5 border border-red-300 text-red-700 rounded-xl text-sm font-medium hover:bg-red-50 transition-colors">
                      <X className="w-4 h-4" /> Reject
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        /* Empty state — desktop only */
        <div className="hidden lg:flex flex-1 items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-slate-200 flex items-center justify-center mx-auto mb-4">
              <Users className="w-8 h-8 text-slate-400" />
            </div>
            <p className="text-slate-600 font-medium">Select a caregiver</p>
            <p className="text-sm text-slate-400 mt-1">Choose one from the list to view their details</p>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 ${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>{toast.msg}</div>
      )}
    </div>
  );
};
