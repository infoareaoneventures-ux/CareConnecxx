import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, Briefcase, MessageSquare, History } from 'lucide-react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { CaregiverSchedule } from './CaregiverSchedule';
import { CaregiverInterviewManager } from './CaregiverInterviewManager';
import { MyApplicationsList } from './MyApplicationsList';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService } from '../../services/api';
import type { Caregiver } from '../../types';

type BookingsTab = 'active' | 'past' | 'applications' | 'interviews';

export const CaregiverBookingsPage: React.FC = () => {
  const { appointments, currentUser, addToast } = useCareConnex();
  const navigate = useNavigate();
  const [tab, setTab] = useState<BookingsTab>('active');
  const [profile, setProfile] = useState<Caregiver | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!currentUser?.uid) return;
      const p = await dbService.getUser(currentUser.uid);
      if (active && p) setProfile(p as any);
    })();
    return () => { active = false; };
  }, [currentUser?.uid]);

  const myAppointments = useMemo(
    () => appointments.filter(a => currentUser && a.caregiverId?.toString() === currentUser.uid),
    [appointments, currentUser]
  );

  const activeAppts = myAppointments.filter(a => a.status === 'confirmed' || a.status === 'in-progress');
  const pastAppts = myAppointments.filter(a => a.status === 'completed' || a.status === 'cancelled');

  const tabs: Array<{ id: BookingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'active', label: 'Active Bookings', icon: <Calendar className="w-4 h-4" /> },
    { id: 'past', label: 'Past Bookings', icon: <History className="w-4 h-4" /> },
    { id: 'applications', label: 'Applications', icon: <Briefcase className="w-4 h-4" /> },
    { id: 'interviews', label: 'Interviews', icon: <MessageSquare className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />

      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 grid md:grid-cols-[1fr_280px] gap-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Bookings</h1>
          <p className="text-sm text-slate-500 mb-6">
            Keep track of your jobs and interviews. Did a family text you about a job? You can add it here and get the benefits of staying on CareConnex.
          </p>

          {/* Pill tabs */}
          <div className="flex flex-wrap gap-2 mb-6">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-primary-500 text-white'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'active' && (
            <CaregiverSchedule
              appointments={activeAppts}
              weeklyAvailability={profile?.weeklyAvailability as unknown as Record<string, string[]>}
            />
          )}

          {tab === 'past' && (
            pastAppts.length === 0 ? (
              <EmptyState title="No past bookings" body="Completed and cancelled jobs will show up here." />
            ) : (
              <CaregiverSchedule
                appointments={pastAppts}
                weeklyAvailability={profile?.weeklyAvailability as unknown as Record<string, string[]>}
              />
            )
          )}

          {tab === 'applications' && (
            <MyApplicationsList
              caregiverId={currentUser?.uid || null}
              onShowToast={addToast}
              emptyCtaLabel="Browse available jobs"
              onEmptyCtaClick={() => navigate('/caregiver/jobs')}
            />
          )}

          {tab === 'interviews' && currentUser?.uid && (
            <CaregiverInterviewManager caregiverId={currentUser.uid} onShowToast={addToast} />
          )}
        </div>

        <aside className="hidden md:block space-y-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <p className="font-bold text-slate-900 mb-3">Why keep jobs on CareConnex?</p>
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-semibold text-slate-900">Peace of mind</p>
                <p className="text-slate-500">Our support team can help with jobs booked on CareConnex — handy if you ever run into a tricky payment situation.</p>
              </div>
              <div>
                <p className="font-semibold text-slate-900">Badges and reviews — more jobs</p>
                <p className="text-slate-500">Earn a Repeat Family badge to boost your profile. We'll automatically remind families to review you.</p>
              </div>
              <div>
                <p className="font-semibold text-slate-900">Reminders</p>
                <p className="text-slate-500">CareConnex helps both you and the family keep track of jobs and payment.</p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};

const EmptyState: React.FC<{ title: string; body: string; ctaLabel?: string; ctaHref?: string }> = ({ title, body, ctaLabel, ctaHref }) => (
  <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
    <p className="font-bold text-slate-900 mb-1">{title}</p>
    <p className="text-sm text-slate-500 mb-4">{body}</p>
    {ctaLabel && ctaHref && (
      <a href={ctaHref} className="inline-flex items-center px-4 py-2 rounded-full bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600">
        {ctaLabel}
      </a>
    )}
  </div>
);
