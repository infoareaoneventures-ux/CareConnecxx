import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft, Calendar, Repeat, ArrowRight, MessageSquare,
  X, Info, AlertCircle, Loader2, CheckCircle2, Clock,
} from 'lucide-react';
import { auth, db } from '../../../lib/firebase';
import { dbService } from '../../../services/api';
import { chatService } from '../../../services/chatService';
import { useAccessGates } from '../../../hooks/useAccessGates';
import { ClientNavigation } from '../ClientNavigation';
import type { JobPost } from '../../../types';

type Step = 'source' | 'frequency' | 'confirmDates' | 'details' | 'done';
type Frequency = 'once' | 'recurring';

interface PerDayTime { startTime: string; endTime: string }

interface CaregiverLite {
  id: string;
  firstName: string;
  lastName: string;
  photo?: string;
  hourlyRate: number;
  city: string;
  minimumRate?: number;
}

interface BookingFormData {
  jobPostId?: string;
  frequency: Frequency;
  startDate: string;
  endDate?: string;
  // "just once" single times
  onceStartTime: string;
  onceEndTime: string;
  // per-day times for recurring
  perDayTimes: Record<string, PerDayTime>;
  daysOfWeek: string[];
  confirmedDates: string[];
  recipientsCount: 1 | 2 | 3 | 4;
  rate: number;
  paymentMethod: 'credit' | 'cash' | 'venmo' | 'zelle';
  description: string;
  streetAddress: string;
  address2: string;
  city: string;
  state: string;
  neighborhood: string;
  zipCode: string;
  phone: string;
}

const WEEKDAYS = [
  { id: 'Sun', label: 'S' },
  { id: 'Mon', label: 'M' },
  { id: 'Tue', label: 'T' },
  { id: 'Wed', label: 'W' },
  { id: 'Thu', label: 'T' },
  { id: 'Fri', label: 'F' },
  { id: 'Sat', label: 'S' },
];

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// 30-min increment options: "12:00 AM" style display, "00:00" value
function buildTimeOptions(): { label: string; value: string }[] {
  const opts: { label: string; value: string }[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const ampm = h < 12 ? 'AM' : 'PM';
      const displayH = h % 12 === 0 ? 12 : h % 12;
      opts.push({ label: `${displayH}:${mm} ${ampm}`, value: `${hh}:${mm}` });
    }
  }
  return opts;
}
const TIME_OPTIONS = buildTimeOptions();

function minutesFromTime(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function durationFromTimes(start: string, end: string): number {
  let mins = minutesFromTime(end) - minutesFromTime(start);
  if (mins <= 0) mins += 24 * 60;
  return Math.round((mins / 60) * 10) / 10;
}

function generateDates(startDate: string, endDate: string | undefined, daysOfWeek: string[]): string[] {
  if (!startDate || daysOfWeek.length === 0) return [];
  const start = new Date(startDate + 'T12:00:00');
  const end = endDate
    ? new Date(endDate + 'T12:00:00')
    : new Date(start.getTime() + 28 * 24 * 60 * 60 * 1000);
  const targetDays = new Set(daysOfWeek.map(d => DAY_INDEX[d]));
  const dates: string[] = [];
  const cur = new Date(start);
  while (cur <= end && dates.length < 365) {
    if (targetDays.has(cur.getDay())) {
      dates.push(cur.toISOString().split('T')[0]);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function formatDateLabel(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function timeLabel(t: string): string {
  return TIME_OPTIONS.find(o => o.value === t)?.label ?? t;
}

const initialForm = (caregiverCity: string, baseRate: number): BookingFormData => ({
  frequency: 'once',
  startDate: '',
  onceStartTime: '10:00',
  onceEndTime: '14:00',
  perDayTimes: {},
  daysOfWeek: [],
  confirmedDates: [],
  recipientsCount: 1,
  rate: baseRate,
  paymentMethod: 'credit',
  description: '',
  streetAddress: '',
  address2: '',
  city: caregiverCity || '',
  state: 'CA',
  neighborhood: '',
  zipCode: '',
  phone: '',
});

// ─── Main component ──────────────────────────────────────────────
export default function BookingFlow() {
  const navigate = useNavigate();
  const { caregiverId } = useParams();
  const [caregiver, setCaregiver] = useState<CaregiverLite | null>(null);
  const [activeJobs, setActiveJobs] = useState<JobPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>('source');
  const [showSpokenDialog, setShowSpokenDialog] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [form, setForm] = useState<BookingFormData>(initialForm('', 25));
  const { gate, Modals: GateModals } = useAccessGates();

  useEffect(() => {
    if (!caregiverId) return;
    load();
  }, [caregiverId]);

  const load = async () => {
    try {
      if (!auth || !db) return;
      const fdb = db;
      const uid = auth.currentUser?.uid;
      if (!uid) { navigate('/login'); return; }

      const [cgDoc, cgUserDoc, jobs, clientDoc] = await Promise.all([
        fdb.collection('caregivers').doc(caregiverId!).get().catch(() => null),
        fdb.collection('users').doc(caregiverId!).get(),
        dbService.getJobPostsByClient(uid),
        fdb.collection('users').doc(uid).get(),
      ]);

      const cgData: any = { ...(cgDoc?.data() || {}), ...(cgUserDoc.data() || {}) };
      const firstName = cgData.firstName || cgData.name?.split(' ')[0] || 'Caregiver';
      const lastName = cgData.lastName || cgData.name?.split(' ').slice(1).join(' ') || '';
      const city = cgData.city || cgData.location?.city || '';
      const hourlyRate = cgData.hourlyRate ?? 25;
      const minimumRate = cgData.minimumRate ?? Math.max(hourlyRate - 5, 8);

      setCaregiver({ id: caregiverId!, firstName, lastName, photo: cgData.photoURL || cgData.imageUrl, hourlyRate, city, minimumRate });

      const clientData: any = clientDoc.data() || {};
      setForm(prev => ({
        ...initialForm(city, hourlyRate),
        phone: clientData.phone || '',
        streetAddress: clientData.address || '',
        city: clientData.city || city || '',
        state: clientData.state || 'CA',
        zipCode: clientData.zipCode || '',
      }));

      setActiveJobs(jobs.filter(j => j.status === 'open'));
    } catch (err) {
      console.error('Booking load error', err);
    } finally {
      setLoading(false);
    }
  };

  const prefillFromJob = (job: JobPost) => {
    const j = job as any;
    setForm(prev => ({
      ...prev,
      jobPostId: job.id,
      frequency: j.ongoing ? 'recurring' : 'once',
      startDate: j.startDate || prev.startDate,
      endDate: j.endDate,
      daysOfWeek: j.daysOfWeek || prev.daysOfWeek,
      rate: j.rate || prev.rate,
      description: job.description || prev.description,
      streetAddress: j.streetAddress || prev.streetAddress,
      city: j.city || prev.city,
      state: j.state || prev.state,
      zipCode: j.zipCode || prev.zipCode,
      neighborhood: j.neighborhood || prev.neighborhood,
    }));
    setStep('frequency');
    setShowSpokenDialog(true);
  };

  const handleCreateNew = () => {
    setStep('frequency');
    setShowSpokenDialog(true);
  };

  const goBack = () => {
    const prev: Record<Step, () => void> = {
      source: () => navigate(-1),
      frequency: () => setStep('source'),
      confirmDates: () => setStep('frequency'),
      details: () => setStep(form.frequency === 'recurring' ? 'confirmDates' : 'frequency'),
      done: () => navigate('/client/calendar'),
    };
    prev[step]();
  };

  const handleFrequencyContinue = () => {
    if (form.frequency === 'recurring') {
      const dates = generateDates(form.startDate, form.endDate, form.daysOfWeek);
      setForm(prev => ({ ...prev, confirmedDates: dates }));
      setStep('confirmDates');
    } else {
      setStep('details');
    }
  };

  const handleSubmit = async () => {
    if (!caregiver) return;
    gate('booking', `${caregiver.firstName} ${caregiver.lastName}`, async () => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        if (!auth) throw new Error('Auth not initialized');
        const uid = auth.currentUser?.uid!;
        const clientName = auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || 'Client';
        const caregiverName = `${caregiver.firstName} ${caregiver.lastName}`;
        const sharedAddress = [form.streetAddress, form.address2].filter(Boolean).join(', ');
        const sharedLocation = [form.city, form.state, form.zipCode].filter(Boolean).join(', ');

        if (form.frequency === 'once') {
          const duration = durationFromTimes(form.onceStartTime, form.onceEndTime);
          const cost = form.rate * duration;
          const isoDate = new Date(`${form.startDate}T${form.onceStartTime}`).toISOString();
          await dbService.createAppointment({
            clientId: uid,
            caregiverId: caregiver.id,
            caregiverName,
            clientName,
            date: form.startDate,
            isoDate,
            time: form.onceStartTime,
            duration,
            paymentStatus: 'pending',
            paymentMethod: form.paymentMethod,
            cost,
            isRecurring: false,
            address: sharedAddress,
            location: sharedLocation,
            notes: form.description,
            status: 'pending_caregiver_confirmation',
          } as any);
        } else {
          const recurringGroupId = crypto.randomUUID();
          const appointments = form.confirmedDates.map(dateStr => {
            const dayKey = WEEKDAYS.find(d => DAY_INDEX[d.id] === new Date(dateStr + 'T12:00:00').getDay())?.id || '';
            const times = form.perDayTimes[dayKey] || { startTime: '10:00', endTime: '14:00' };
            const duration = durationFromTimes(times.startTime, times.endTime);
            return {
              clientId: uid,
              caregiverId: caregiver.id,
              caregiverName,
              clientName,
              date: dateStr,
              isoDate: new Date(`${dateStr}T${times.startTime}`).toISOString(),
              time: times.startTime,
              duration,
              paymentStatus: 'pending' as const,
              paymentMethod: form.paymentMethod,
              cost: form.rate * duration,
              isRecurring: true,
              recurringGroupId,
              address: sharedAddress,
              location: sharedLocation,
              notes: form.description,
              status: 'pending_caregiver_confirmation' as const,
            };
          });
          await (dbService as any).createRecurringBookings(appointments);
        }

        // Kick off conversation
        try {
          const roomId = await chatService.getOrCreateChatRoom(uid, clientName, caregiver.id, caregiverName);
          if (form.description) await chatService.sendMessage(roomId, uid, clientName, form.description);
        } catch { /* non-fatal */ }

        setStep('done');
      } catch (err: any) {
        console.error('Booking submit error', err);
        setSubmitError(err.message || 'Could not create booking. Please try again.');
      } finally {
        setSubmitting(false);
      }
    });
  };

  // ── Loading / not-found guards ──
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="flex items-center justify-center h-[calc(100vh-64px)]">
          <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
        </div>
      </div>
    );
  }

  if (!caregiver) {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-2xl mx-auto p-8 text-center">
          <p className="text-slate-500">Caregiver not found.</p>
          <button onClick={() => navigate('/client/find-caregivers')} className="mt-4 px-5 py-2 bg-primary-600 text-white rounded-full">
            Back to search
          </button>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <BookingConfirmation
          caregiver={caregiver}
          form={form}
          onInbox={() => navigate('/client/inbox')}
          onDashboard={() => navigate('/client/calendar')}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <button
          onClick={goBack}
          className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-4"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>

        <StepHeader step={step} />

        {step === 'source' && (
          <JobSourceStep
            caregiver={caregiver}
            jobs={activeJobs}
            onCreateNew={handleCreateNew}
            onUseJob={prefillFromJob}
          />
        )}

        {step === 'frequency' && (
          <FrequencyStep
            caregiver={caregiver}
            form={form}
            onChange={setForm}
            onContinue={handleFrequencyContinue}
          />
        )}

        {step === 'confirmDates' && (
          <ConfirmDatesStep
            form={form}
            onChange={setForm}
            onContinue={() => setStep('details')}
          />
        )}

        {step === 'details' && (
          <DetailsStep
            caregiver={caregiver}
            form={form}
            onChange={setForm}
            submitting={submitting}
            submitError={submitError}
            onBook={handleSubmit}
          />
        )}
      </main>

      {showSpokenDialog && (
        <SpokenDialog
          caregiverName={caregiver.firstName}
          onClose={() => setShowSpokenDialog(false)}
          onMessage={() => {
            setShowSpokenDialog(false);
            gate('message', `${caregiver.firstName} ${caregiver.lastName}`, () => {
              if (!auth) return;
              const uid = auth.currentUser?.uid;
              if (!uid) return;
              const clientName = auth.currentUser?.displayName || 'Client';
              const caregiverFullName = `${caregiver.firstName} ${caregiver.lastName}`;
              const sorted = [uid, caregiver.id].sort();
              const roomId = sorted.join('_');
              const names = sorted.map(id => id === uid ? clientName : caregiverFullName);
              const avatars = sorted.map(id => id === uid ? '' : ((caregiver as any).imageUrl || (caregiver as any).photo || ''));
              navigate(`/client/inbox?room=${roomId}`, {
                state: {
                  pendingRoom: {
                    id: roomId, participants: sorted, participantNames: names, participantAvatars: avatars,
                    unreadCount: { [uid]: 0, [caregiver.id]: 0 },
                    lastMessage: '', lastMessageTime: '', lastMessageTimestamp: null, createdAt: null,
                  }
                }
              });
            });
          }}
          onContinue={() => setShowSpokenDialog(false)}
        />
      )}

      <GateModals />
    </div>
  );
}

// ─── Step progress header ─────────────────────────────────────────
const STEPS: { key: Step; label: string }[] = [
  { key: 'source', label: 'Job details' },
  { key: 'frequency', label: 'Schedule' },
  { key: 'confirmDates', label: 'Confirm dates' },
  { key: 'details', label: 'Review & book' },
];

const StepHeader: React.FC<{ step: Step }> = ({ step }) => {
  const idx = STEPS.findIndex(s => s.key === step);
  if (idx < 0) return null;
  return (
    <div className="flex items-center gap-2 mb-6">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.key}>
          <div className={`flex items-center gap-1.5 text-sm ${i <= idx ? 'text-primary-700 font-semibold' : 'text-slate-400'}`}>
            <span className={`w-6 h-6 rounded-full inline-flex items-center justify-center text-xs ${i <= idx ? 'bg-primary-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
              {i + 1}
            </span>
            <span className="hidden sm:inline">{s.label}</span>
          </div>
          {i < STEPS.length - 1 && <div className={`flex-1 h-px ${i < idx ? 'bg-primary-600' : 'bg-slate-200'}`} />}
        </React.Fragment>
      ))}
    </div>
  );
};

// ─── Step 1: Job Source ───────────────────────────────────────────
const JobSourceStep: React.FC<{
  caregiver: CaregiverLite;
  jobs: JobPost[];
  onCreateNew: () => void;
  onUseJob: (job: JobPost) => void;
}> = ({ caregiver, jobs, onCreateNew, onUseJob }) => (
  <div>
    <h2 className="text-xl font-bold text-slate-900 mb-1">
      Want to use details from an active job post?
    </h2>
    <p className="text-sm text-slate-500 mb-5">
      We'll prefill the booking with that job's schedule and rate so you don't have to retype.
    </p>

    <button
      onClick={onCreateNew}
      className="w-full flex items-center justify-between text-left p-4 rounded-2xl border border-primary-200 bg-white hover:border-primary-500 transition-colors group mb-4"
    >
      <div>
        <p className="font-semibold text-primary-700">Create a new job booking</p>
        <p className="text-sm text-slate-500">Start fresh and tell us what you need for {caregiver.firstName}.</p>
      </div>
      <ArrowRight className="w-5 h-5 text-primary-600 group-hover:translate-x-1 transition-transform" />
    </button>

    {jobs.length > 0 && (
      <>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Your active job posts</p>
        <div className="space-y-2">
          {jobs.map(job => {
            const j = job as any;
            return (
              <button
                key={job.id}
                onClick={() => onUseJob(job)}
                className="w-full text-left p-4 rounded-2xl border border-slate-200 bg-white hover:border-slate-300 transition-colors"
              >
                <p className="font-semibold text-slate-900">{job.title || 'Senior care'}</p>
                <p className="text-sm text-slate-600 mt-0.5">
                  {j.ongoing ? 'Ongoing' : 'Date-specific'}
                  {j.startDate && `, starting ${new Date(j.startDate + 'T12:00:00').toLocaleDateString()}`}
                </p>
              </button>
            );
          })}
        </div>
      </>
    )}
  </div>
);

// ─── Step 2: Frequency + per-day times ───────────────────────────
const FrequencyStep: React.FC<{
  caregiver: CaregiverLite;
  form: BookingFormData;
  onChange: React.Dispatch<React.SetStateAction<BookingFormData>>;
  onContinue: () => void;
}> = ({ caregiver, form, onChange, onContinue }) => {
  const toggleDay = (d: string) => {
    onChange(prev => {
      const has = prev.daysOfWeek.includes(d);
      const daysOfWeek = has ? prev.daysOfWeek.filter(x => x !== d) : [...prev.daysOfWeek, d];
      const perDayTimes = { ...prev.perDayTimes };
      if (has) {
        delete perDayTimes[d];
      } else if (!perDayTimes[d]) {
        perDayTimes[d] = { startTime: '10:00', endTime: '14:00' };
      }
      return { ...prev, daysOfWeek, perDayTimes };
    });
  };

  const setDayTime = (day: string, field: 'startTime' | 'endTime', value: string) => {
    onChange(prev => ({
      ...prev,
      perDayTimes: { ...prev.perDayTimes, [day]: { ...prev.perDayTimes[day], [field]: value } },
    }));
  };

  const canContinue = !!form.startDate && (
    form.frequency === 'once' || (form.daysOfWeek.length > 0)
  );

  const buttonLabel = form.frequency === 'recurring' ? 'Next, confirm dates' : 'Continue';

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-900 mb-1">When do you need this care?</h2>
      <p className="text-sm text-slate-500 mb-5">Tell {caregiver.firstName} when to plan for.</p>

      <div className="grid sm:grid-cols-2 gap-3 mb-5">
        <button
          onClick={() => onChange(prev => ({ ...prev, frequency: 'once' }))}
          className={`text-left p-4 rounded-2xl border-2 transition-colors ${
            form.frequency === 'once' ? 'border-primary-500 bg-primary-50' : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <Calendar className="w-5 h-5 text-primary-600 mb-2" />
          <p className="font-semibold text-slate-900">Just once</p>
          <p className="text-xs text-slate-500 mt-0.5">Send a booking request for a specific date and time.</p>
        </button>
        <button
          onClick={() => onChange(prev => ({ ...prev, frequency: 'recurring' }))}
          className={`text-left p-4 rounded-2xl border-2 transition-colors ${
            form.frequency === 'recurring' ? 'border-primary-500 bg-primary-50' : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <Repeat className="w-5 h-5 text-primary-600 mb-2" />
          <p className="font-semibold text-slate-900">On a recurring basis</p>
          <p className="text-xs text-slate-500 mt-0.5">Send multiple booking requests based on a recurring schedule.</p>
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        {/* Date range */}
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label={form.frequency === 'recurring' ? 'Starting' : 'Date'}>
            <input
              type="date"
              value={form.startDate}
              min={new Date().toISOString().split('T')[0]}
              onChange={e => onChange(prev => ({ ...prev, startDate: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </Field>
          {form.frequency === 'recurring' && (
            <Field label="Ending (optional)">
              <input
                type="date"
                value={form.endDate || ''}
                min={form.startDate || undefined}
                onChange={e => onChange(prev => ({ ...prev, endDate: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </Field>
          )}
        </div>

        {form.frequency === 'recurring' && (
          <p className="text-xs text-slate-500 -mt-2">
            Based on your start and end date, an editable list of dates will be generated.
          </p>
        )}

        {/* "Just once" time slots */}
        {form.frequency === 'once' && (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Start time">
              <TimeSelect value={form.onceStartTime} onChange={v => onChange(prev => ({ ...prev, onceStartTime: v }))} />
            </Field>
            <Field label="End time">
              <TimeSelect value={form.onceEndTime} onChange={v => onChange(prev => ({ ...prev, onceEndTime: v }))} />
            </Field>
          </div>
        )}

        {/* Recurring: day of week toggles + per-day times */}
        {form.frequency === 'recurring' && (
          <>
            <Field label="Select Days of the Week">
              <div className="flex gap-1.5 flex-wrap">
                {WEEKDAYS.map(d => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDay(d.id)}
                    className={`w-9 h-9 rounded-full text-sm font-semibold border transition-colors ${
                      form.daysOfWeek.includes(d.id)
                        ? 'bg-primary-600 border-primary-600 text-white'
                        : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </Field>

            {/* Per-day time rows */}
            {form.daysOfWeek.length > 0 && (
              <div className="space-y-3 pt-1">
                {form.daysOfWeek.map(day => {
                  const times = form.perDayTimes[day] || { startTime: '10:00', endTime: '14:00' };
                  return (
                    <div key={day} className="flex items-center gap-3">
                      <span className="w-24 text-sm font-medium text-slate-700">{day}</span>
                      <div className="flex items-center gap-2 flex-1">
                        <TimeSelect value={times.startTime} onChange={v => setDayTime(day, 'startTime', v)} />
                        <span className="text-slate-400 text-sm">–</span>
                        <TimeSelect value={times.endTime} onChange={v => setDayTime(day, 'endTime', v)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <button
        onClick={onContinue}
        disabled={!canContinue}
        className="mt-5 px-6 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
      >
        {buttonLabel}
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
};

// ─── Step 3: Confirm exact dates ──────────────────────────────────
const ConfirmDatesStep: React.FC<{
  form: BookingFormData;
  onChange: React.Dispatch<React.SetStateAction<BookingFormData>>;
  onContinue: () => void;
}> = ({ form, onChange, onContinue }) => {
  const allDates = useMemo(
    () => generateDates(form.startDate, form.endDate, form.daysOfWeek),
    [form.startDate, form.endDate, form.daysOfWeek],
  );

  // Initialise confirmedDates if empty (first visit)
  useEffect(() => {
    if (form.confirmedDates.length === 0 && allDates.length > 0) {
      onChange(prev => ({ ...prev, confirmedDates: allDates }));
    }
  }, [allDates]);

  const confirmed = new Set(form.confirmedDates);

  const toggle = (date: string) => {
    onChange(prev => {
      const next = new Set(prev.confirmedDates);
      next.has(date) ? next.delete(date) : next.add(date);
      return { ...prev, confirmedDates: Array.from(next) };
    });
  };

  const getDayTimes = (iso: string) => {
    const dayKey = WEEKDAYS.find(d => DAY_INDEX[d.id] === new Date(iso + 'T12:00:00').getDay())?.id || '';
    return form.perDayTimes[dayKey];
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-900 mb-1">Confirm exact dates</h2>
      <p className="text-sm text-slate-500 mb-5">
        {form.confirmedDates.length} of {allDates.length} dates selected. Click a date to remove it.
      </p>

      <div className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-100 overflow-hidden mb-5">
        {allDates.length === 0 && (
          <p className="px-5 py-4 text-sm text-slate-500">No dates generated. Go back and pick days of the week.</p>
        )}
        {allDates.map(date => {
          const isOn = confirmed.has(date);
          const times = getDayTimes(date);
          return (
            <button
              key={date}
              type="button"
              onClick={() => toggle(date)}
              className={`w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-slate-50 ${!isOn ? 'opacity-40' : ''}`}
            >
              <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                isOn ? 'bg-primary-600 border-primary-600' : 'border-slate-300'
              }`}>
                {isOn && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
              </span>
              <span className="text-sm text-slate-800">
                {formatDateLabel(date)}
                {times && (
                  <span className="text-slate-500 ml-2">
                    {timeLabel(times.startTime)} – {timeLabel(times.endTime)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <button
        onClick={onContinue}
        disabled={form.confirmedDates.length === 0}
        className="px-6 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
      >
        Next
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
};

// ─── Step 4: Review details and book ─────────────────────────────
const DetailsStep: React.FC<{
  caregiver: CaregiverLite;
  form: BookingFormData;
  onChange: React.Dispatch<React.SetStateAction<BookingFormData>>;
  submitting: boolean;
  submitError: string | null;
  onBook: () => void;
}> = ({ caregiver, form, onChange, submitting, submitError, onBook }) => {
  const minRate = caregiver.minimumRate || 8;
  const rateBelowMin = form.rate < minRate;
  const locationValid = !!form.streetAddress && !!form.city && !!form.state && !!form.zipCode;
  const phoneValid = /^[\d\s()+.\-]{10,}$/.test(form.phone);
  const canBook = locationValid && phoneValid && !rateBelowMin && !!form.startDate;

  const dateTimeSummary = useMemo(() => {
    if (form.frequency === 'once') {
      const d = form.startDate ? formatDateLabel(form.startDate) : '—';
      return `${d} at ${timeLabel(form.onceStartTime)} – ${timeLabel(form.onceEndTime)}`;
    }
    const n = form.confirmedDates.length;
    const first = form.confirmedDates[0];
    const last = form.confirmedDates[form.confirmedDates.length - 1];
    const days = form.daysOfWeek.join(', ');
    return `${n} date${n !== 1 ? 's' : ''} (${days}) · ${first ? formatDateLabel(first) : ''} – ${last ? formatDateLabel(last) : ''}`;
  }, [form]);

  return (
    <div>
      <div className="bg-primary-50 border border-primary-200 rounded-xl p-3 mb-5 flex items-start gap-2">
        <Info className="w-4 h-4 text-primary-700 mt-0.5 flex-shrink-0" />
        <div className="text-sm">
          <span className="font-semibold text-primary-800">FYI:</span>{' '}
          <span className="text-primary-700">This caregiver's minimum rate is ${caregiver.hourlyRate}/hr.</span>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_1fr] gap-5">
        {/* Left column */}
        <div className="space-y-4">
          {/* Review date/time summary */}
          <section className="bg-white border border-slate-200 rounded-2xl p-5">
            <div className="flex items-start gap-3">
              {caregiver.photo && (
                <img src={caregiver.photo} alt={caregiver.firstName} className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
              )}
              <div>
                <h2 className="font-bold text-slate-900 text-lg">Review details and book</h2>
                <div className="text-sm text-slate-600 mt-1 space-y-0.5">
                  <p className="flex items-start gap-1.5"><Clock className="w-3.5 h-3.5 mt-0.5 text-slate-400 flex-shrink-0" />{dateTimeSummary}</p>
                </div>
              </div>
            </div>
          </section>

          {/* Describe the job */}
          <section className="bg-white border border-slate-200 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold text-slate-900">Describe the Job</h2>
            </div>
            <textarea
              rows={5}
              placeholder={`Hi ${caregiver.firstName}, I'm looking for help with…`}
              value={form.description}
              onChange={e => onChange(prev => ({ ...prev, description: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
            />
            <p className="text-xs text-slate-500 mt-1">This gets sent as your first message.</p>
          </section>
        </div>

        {/* Right column: job details form */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5">
          <h2 className="font-semibold text-slate-900 mb-4">Job Details</h2>

          <Field label="Receiving Care">
            <select
              value={form.recipientsCount}
              onChange={e => onChange(prev => ({ ...prev, recipientsCount: Number(e.target.value) as 1 | 2 | 3 | 4 }))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500"
            >
              <option value={1}>1 senior receiving care</option>
              <option value={2}>2 seniors</option>
              <option value={3}>3 seniors</option>
              <option value={4}>4+ seniors</option>
            </select>
          </Field>

          <Field label="Payment type">
            <div className="flex items-center gap-2">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                <input
                  type="number" min={minRate}
                  value={form.rate}
                  onChange={e => onChange(prev => ({ ...prev, rate: Number(e.target.value) }))}
                  className={`w-24 pl-6 pr-2 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 ${rateBelowMin ? 'border-red-400' : 'border-slate-200'}`}
                />
              </div>
              <select disabled className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-700">
                <option>Rate per hour</option>
              </select>
            </div>
            {rateBelowMin && <p className="text-xs text-red-600 mt-1">Minimum allowed rate: ${minRate}/hr</p>}
          </Field>

          <Field label="Payment method">
            <div className="flex flex-wrap items-center gap-5">
              {([['credit', 'Credit Card'], ['cash', 'Cash'], ['venmo', 'Venmo'], ['zelle', 'Zelle']] as const).map(([method, label]) => (
                <label key={method} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="radio"
                    checked={form.paymentMethod === method}
                    onChange={() => onChange(prev => ({ ...prev, paymentMethod: method }))}
                    className="accent-teal-600"
                  />
                  {label}
                </label>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Location of Job">
              <input
                type="text" placeholder="Street"
                value={form.streetAddress}
                onChange={e => onChange(prev => ({ ...prev, streetAddress: e.target.value }))}
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 ${!form.streetAddress ? 'border-red-300' : 'border-slate-200'}`}
              />
            </Field>
            <Field label="Address 2">
              <input
                type="text" placeholder="Apt #"
                value={form.address2}
                onChange={e => onChange(prev => ({ ...prev, address2: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="City">
              <input
                type="text"
                value={form.city}
                onChange={e => onChange(prev => ({ ...prev, city: e.target.value }))}
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 ${!form.city ? 'border-red-300' : 'border-slate-200'}`}
              />
            </Field>
            <Field label="State">
              <input
                type="text" maxLength={2}
                value={form.state}
                onChange={e => onChange(prev => ({ ...prev, state: e.target.value.toUpperCase() }))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Neighborhood">
              <input
                type="text" placeholder="Neighborhood"
                value={form.neighborhood}
                onChange={e => onChange(prev => ({ ...prev, neighborhood: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500"
              />
            </Field>
            <Field label="Zip Code">
              <input
                type="text" maxLength={5}
                value={form.zipCode}
                onChange={e => onChange(prev => ({ ...prev, zipCode: e.target.value }))}
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 ${!form.zipCode ? 'border-red-300' : 'border-slate-200'}`}
              />
            </Field>
          </div>

          {!locationValid && (
            <p className="text-xs text-red-600 -mt-2 mb-2">Please add or correct location information.</p>
          )}

          <Field label="Phone">
            <input
              type="tel" placeholder="xxx-xxx-xxxx"
              value={form.phone}
              onChange={e => onChange(prev => ({ ...prev, phone: e.target.value }))}
              className={`w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 ${!phoneValid ? 'border-red-300' : 'border-slate-200'}`}
            />
          </Field>
          {!phoneValid && <p className="text-xs text-red-600 -mt-2">Please enter a valid phone number.</p>}
        </section>
      </div>

      {submitError && (
        <div className="mt-5 bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-700">{submitError}</p>
        </div>
      )}

      <div className="mt-6 flex justify-center">
        <button
          onClick={onBook}
          disabled={!canBook || submitting}
          className="px-10 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending request…</> : 'Book'}
        </button>
      </div>
    </div>
  );
};

// ─── Booking Confirmation (step 'done') ───────────────────────────
const BookingConfirmation: React.FC<{
  caregiver: CaregiverLite;
  form: BookingFormData;
  onInbox: () => void;
  onDashboard: () => void;
}> = ({ caregiver, form, onInbox, onDashboard }) => {
  const n = form.confirmedDates.length;
  const first = form.confirmedDates[0];

  return (
    <div className="max-w-lg mx-auto px-4 py-16 text-center">
      <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-5">
        <CheckCircle2 className="w-9 h-9 text-green-600" />
      </div>

      <h1 className="text-2xl font-bold text-slate-900 mb-2">Booking request sent!</h1>

      {caregiver.photo && (
        <img src={caregiver.photo} alt={caregiver.firstName} className="w-16 h-16 rounded-full object-cover mx-auto my-4" />
      )}

      <p className="text-slate-600 mb-1">
        Your booking request has been sent to <span className="font-semibold">{caregiver.firstName}</span>.
      </p>
      <p className="text-sm text-slate-500 mb-1">They typically respond within 24 hours.</p>

      {form.frequency === 'recurring' && n > 0 && (
        <p className="text-sm text-slate-600 mt-3">
          <span className="font-semibold">{n} date{n !== 1 ? 's' : ''}</span>
          {first && <> starting {formatDateLabel(first)}</>}
        </p>
      )}

      {form.frequency === 'once' && form.startDate && (
        <p className="text-sm text-slate-600 mt-3">{formatDateLabel(form.startDate)} · {timeLabel(form.onceStartTime)} – {timeLabel(form.onceEndTime)}</p>
      )}

      <div className="flex gap-3 justify-center mt-8">
        <button
          onClick={onInbox}
          className="px-5 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 inline-flex items-center gap-2"
        >
          <MessageSquare className="w-4 h-4" />
          View inbox
        </button>
        <button
          onClick={onDashboard}
          className="px-5 py-2.5 border border-slate-200 text-slate-700 font-semibold rounded-full hover:bg-slate-50"
        >
          Go to schedule
        </button>
      </div>
    </div>
  );
};

// ─── Spoken-with-caregiver dialog ─────────────────────────────────
const SpokenDialog: React.FC<{
  caregiverName: string;
  onClose: () => void;
  onMessage: () => void;
  onContinue: () => void;
}> = ({ caregiverName, onClose, onMessage, onContinue }) => (
  <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
    <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
      <button onClick={onClose} className="absolute top-3 right-3 p-1 text-slate-400 hover:text-slate-600">
        <X className="w-4 h-4" />
      </button>
      <div className="p-5">
        <h3 className="font-semibold text-slate-900 mb-2">Have you spoken with {caregiverName} yet?</h3>
        <p className="text-sm text-slate-600 leading-relaxed mb-4">
          Caregivers tell us they appreciate a quick note. Recurring bookings can be a big commitment, so it's important to ensure you're a good fit.
        </p>
        <div className="flex gap-2">
          <button
            onClick={onMessage}
            className="flex-1 py-2 bg-primary-600 text-white text-sm font-semibold rounded-full hover:bg-primary-700 inline-flex items-center justify-center gap-1.5"
          >
            <MessageSquare className="w-4 h-4" />
            Message
          </button>
          <button
            onClick={onContinue}
            className="flex-1 py-2 border border-slate-200 text-slate-700 text-sm font-semibold rounded-full hover:bg-slate-50"
          >
            Continue to Booking
          </button>
        </div>
      </div>
    </div>
  </div>
);

// ─── Shared UI helpers ────────────────────────────────────────────
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="mb-3">
    <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
    {children}
  </div>
);

const TimeSelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <select
    value={value}
    onChange={e => onChange(e.target.value)}
    className="flex-1 min-w-0 px-2 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
  >
    {TIME_OPTIONS.map(o => (
      <option key={o.value} value={o.value}>{o.label}</option>
    ))}
  </select>
);
