import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Mail, Lock, Phone, User as UserIcon } from 'lucide-react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService } from '../../services/api';
import type { Caregiver, UserProfile } from '../../types';

type NotificationKey =
  | 'monthlyTips'
  | 'weeklySummary'
  | 'jobAlerts'
  | 'confirmWeekendAvailability'
  | 'smsOnBookingRequest'
  | 'smsOnInterviewRequest'
  | 'smsImportant'
  | 'jobApplicationNotifications';

const NOTIFICATION_LABELS: Record<NotificationKey, string> = {
  monthlyTips: 'Send me monthly tips and news from CareConnex',
  weeklySummary: 'Send me a weekly summary of my availability and bookings',
  jobAlerts: 'Send me alerts for jobs posted within the working distance set on my profile',
  confirmWeekendAvailability: 'Remind me to confirm my weekend availability',
  smsOnBookingRequest: 'Send a text message when a family sends me a job request',
  smsOnInterviewRequest: 'Send a text message when a family sends me an interview request',
  smsImportant: 'Send a text message with important account notifications',
  jobApplicationNotifications: 'Receive job post application notifications by default',
};

export const CaregiverAccountSettings: React.FC = () => {
  const { currentUser, addToast } = useCareConnex();
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [prefs, setPrefs] = useState<Partial<UserProfile>>({});
  const [openAccount, setOpenAccount] = useState(true);
  const [openComm, setOpenComm] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!currentUser?.uid) return;
      const p = await dbService.getUser(currentUser.uid);
      if (active && p) {
        setProfile(p as any);
        setPrefs({
          notificationPrefs: (p as any).notificationPrefs,
          bookingRequestPolicy: (p as any).bookingRequestPolicy,
          notAcceptingNewFamilies: (p as any).notAcceptingNewFamilies,
        });
      }
    })();
    return () => { active = false; };
  }, [currentUser?.uid]);

  const toggleNotif = (key: NotificationKey, next: boolean) => {
    setPrefs(p => ({ ...p, notificationPrefs: { ...p.notificationPrefs, [key]: next } }));
  };

  const save = async () => {
    if (!currentUser?.uid) return;
    try {
      await dbService.updateUser('caregivers', currentUser.uid, prefs as any);
      addToast('Settings saved', 'success');
    } catch {
      addToast('Failed to save settings', 'error');
    }
  };

  const memberSince = (profile as any)?.createdAt ? new Date((profile as any).createdAt).toLocaleDateString() : '—';

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Account Settings</h1>

        <Accordion open={openAccount} onToggle={() => setOpenAccount(o => !o)} title="Account Basics">
          <Row label="Name" value={<span>{profile?.name} <span className="block text-xs text-slate-400">Member since {memberSince}</span></span>} icon={<UserIcon className="w-4 h-4" />} />
          <Row label="Membership plan" value={<a href="/caregiver/membership" className="text-primary-600 hover:underline">Manage plan</a>} />
          <Row label="Profile status" value={(profile as any)?.profileVisibility === 'hidden' ? 'Hidden' : 'Visible'} />
          <Row label="Email" value={profile?.email || '—'} icon={<Mail className="w-4 h-4" />} />
          <Row label="Password" value={<a href="/caregiver/profile" className="text-primary-600 hover:underline">Change password</a>} icon={<Lock className="w-4 h-4" />} />
          <Row label="Mobile phone" value={profile?.phone || '—'} icon={<Phone className="w-4 h-4" />} />
        </Accordion>

        <Accordion open={openComm} onToggle={() => setOpenComm(o => !o)} title="Communication">
          <div className="p-5 space-y-3">
            <p className="text-xs font-semibold text-slate-500 uppercase">Notifications</p>
            {(Object.keys(NOTIFICATION_LABELS) as NotificationKey[]).map(k => (
              <label key={k} className="flex items-start gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-primary-500 focus:ring-primary-500"
                  checked={!!prefs.notificationPrefs?.[k]}
                  onChange={e => toggleNotif(k, e.target.checked)}
                />
                <span>{NOTIFICATION_LABELS[k]}</span>
              </label>
            ))}
            <div className="pt-3 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Booking requests</p>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="bookingPolicy"
                  checked={prefs.bookingRequestPolicy !== 'only-when-available'}
                  onChange={() => setPrefs(p => ({ ...p, bookingRequestPolicy: 'any-time-slot' }))}
                />
                Send interview/job requests for any time slot
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="bookingPolicy"
                  checked={prefs.bookingRequestPolicy === 'only-when-available'}
                  onChange={() => setPrefs(p => ({ ...p, bookingRequestPolicy: 'only-when-available' }))}
                />
                Send interview/job requests only for the times I show available
              </label>
            </div>
            <div className="pt-3 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-500 uppercase mb-2">New families</p>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={!!prefs.notAcceptingNewFamilies}
                  onChange={e => setPrefs(p => ({ ...p, notAcceptingNewFamilies: e.target.checked }))}
                />
                Not accepting new families
              </label>
            </div>
            <div className="pt-3 flex justify-end">
              <button onClick={save} className="px-4 py-2 rounded-full bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600">
                Save changes
              </button>
            </div>
          </div>
        </Accordion>

      </div>
    </div>
  );
};

const Accordion: React.FC<{ open: boolean; onToggle: () => void; title: string; children: React.ReactNode }> = ({ open, onToggle, title, children }) => (
  <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-3">
    <button onClick={onToggle} className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-slate-50 transition-colors">
      <span className="font-semibold text-slate-900">{title}</span>
      {open ? <ChevronDown className="w-5 h-5 text-slate-400" /> : <ChevronRight className="w-5 h-5 text-slate-400" />}
    </button>
    {open && <div className="border-t border-slate-100">{children}</div>}
  </div>
);

const Row: React.FC<{ label: string; value: React.ReactNode; icon?: React.ReactNode }> = ({ label, value, icon }) => (
  <div className="px-5 py-3 flex items-center gap-3 text-sm border-b border-slate-100 last:border-0">
    {icon && <span className="text-slate-400">{icon}</span>}
    <span className="text-slate-500 w-40 flex-shrink-0">{label}</span>
    <span className="text-slate-900 flex-1">{value}</span>
  </div>
);
