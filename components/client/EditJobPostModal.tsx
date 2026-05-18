import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Check, Calendar, DollarSign, Heart, Home } from 'lucide-react';
import { db } from '../../lib/firebase';
import firebase from '../../lib/firebase';
import { JobPost } from '../../types';

const CARE_TYPES = [
  'Mobility Assistance',
  'Dementia / Memory Care',
  'Medication Reminders',
  'Personal Care',
  'Companionship',
  'Transportation',
  'Meal Preparation',
  'Light Housekeeping',
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const TIME_OPTIONS = [
  { value: 'morning',   label: 'Morning',   sub: '6am–12pm' },
  { value: 'afternoon', label: 'Afternoon', sub: '12pm–6pm' },
  { value: 'evening',   label: 'Evening',   sub: '6pm–11pm' },
  { value: 'overnight', label: 'Overnight', sub: '11pm–6am' },
];

const FREQ_OPTIONS = [
  { value: 'occasional', label: 'Occasional' },
  { value: 'part-time', label: 'Part-time' },
  { value: 'full-time', label: 'Full-time' },
];

interface EditForm {
  description: string;
  rate: number;
  rateFlexible: boolean;
  jobFrequency: string;
  startDate: string;
  endDate: string;
  ongoing: boolean;
  daysOfWeek: string[];
  timeOfDay: string[];
  careTypes: string[];
  petsInHome: boolean;
  smokingHousehold: boolean;
  caregiversNeeded: number;
  recipientsCount: number;
}

interface Props {
  post: JobPost;
  onClose: () => void;
  onSaved: (updated: Partial<JobPost>) => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

const chip = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors cursor-pointer select-none ${
    active
      ? 'bg-primary-600 text-white border-primary-600'
      : 'bg-white text-slate-600 border-slate-200 hover:border-primary-300'
  }`;

const SectionHead: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <div className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-3">
    <span className="text-primary-600">{icon}</span>
    {label}
  </div>
);

export const EditJobPostModal: React.FC<Props> = ({ post, onClose, onSaved, onShowToast }) => {
  const p = post as any;

  const [form, setForm] = useState<EditForm>({
    description: post.description || '',
    rate: post.rate || 0,
    rateFlexible: p.rateFlexible || false,
    jobFrequency: p.jobFrequency === 'one-time' ? 'occasional' : (p.jobFrequency || ''),
    startDate: post.startDate || (post as any).date || '',
    endDate: post.endDate || '',
    ongoing: p.ongoing || false,
    daysOfWeek: post.daysOfWeek || [],
    timeOfDay: Array.isArray(post.timeOfDay) ? post.timeOfDay : (post.timeOfDay ? [post.timeOfDay] : []),
    careTypes: post.careTypes || p.requirements || [],
    petsInHome: p.petsInHome || false,
    smokingHousehold: p.smokingHousehold || false,
    caregiversNeeded: p.caregiversNeeded || 1,
    recipientsCount: p.recipientsCount || 1,
  });

  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<EditForm>) => setForm(f => ({ ...f, ...patch }));

  const toggleArr = (field: 'daysOfWeek' | 'timeOfDay' | 'careTypes', val: string) => {
    const arr = form[field] as string[];
    set({ [field]: arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val] });
  };

  const handleSave = async () => {
    if (form.careTypes.length === 0) { onShowToast('Select at least one care type', 'error'); return; }
    if (!db) { onShowToast('Database error', 'error'); return; }

    setSaving(true);
    try {
      const payload: Record<string, any> = {
        description: form.description.trim(),
        rate: form.rateFlexible ? 0 : form.rate,
        rateFlexible: form.rateFlexible,
        jobFrequency: form.jobFrequency,
        startDate: form.startDate,
        endDate: form.ongoing ? '' : form.endDate,
        ongoing: form.ongoing,
        daysOfWeek: form.daysOfWeek,
        timeOfDay: form.timeOfDay,
        careTypes: form.careTypes,
        petsInHome: form.petsInHome,
        smokingHousehold: form.smokingHousehold,
        caregiversNeeded: form.caregiversNeeded,
        recipientsCount: form.recipientsCount,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection('job_posts').doc(post.id).update(payload);
      onSaved(payload as Partial<JobPost>);
      onShowToast('Post updated', 'success');
      onClose();
    } catch (err: any) {
      onShowToast(err?.message || 'Failed to save changes', 'error');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h2 className="font-bold text-slate-900 text-lg">Edit Care Request</h2>
            <p className="text-xs text-slate-400 mt-0.5">Changes are visible to caregivers immediately</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-7">

          {/* ── Description ── */}
          <section>
            <SectionHead icon={<Heart className="w-4 h-4" />} label="Description" />
            <textarea
              value={form.description}
              onChange={e => set({ description: e.target.value })}
              rows={4}
              maxLength={2500}
              className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-primary-400 resize-none"
            />
          </section>

          <hr className="border-slate-100" />

          {/* ── Schedule ── */}
          <section>
            <SectionHead icon={<Calendar className="w-4 h-4" />} label="Schedule" />
            <div className="space-y-4">
              {/* Frequency */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-2">Frequency</label>
                <div className="flex gap-2 flex-wrap">
                  {FREQ_OPTIONS.map(f => (
                    <button key={f.value} type="button" onClick={() => set({ jobFrequency: f.value })} className={chip(form.jobFrequency === f.value)}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Recipients count */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-2">Care Recipients</label>
                <div className="inline-flex items-center gap-3 bg-white border-2 border-slate-200 rounded-xl px-3 py-2">
                  <button type="button" onClick={() => set({ recipientsCount: Math.max(1, form.recipientsCount - 1) })} disabled={form.recipientsCount <= 1}
                    className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                    <span className="text-lg leading-none">−</span>
                  </button>
                  <span className="w-8 text-center text-lg font-semibold text-slate-900">{form.recipientsCount}</span>
                  <button type="button" onClick={() => set({ recipientsCount: Math.min(4, form.recipientsCount + 1) })} disabled={form.recipientsCount >= 4}
                    className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                    <span className="text-lg leading-none">+</span>
                  </button>
                  <span className="text-sm text-slate-500">{form.recipientsCount === 1 ? 'Care Recipient' : 'Care Recipients'}</span>
                </div>
              </div>

              {/* Caregivers needed */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Caregivers Needed</label>
                <div className="inline-flex items-center gap-3 bg-white border-2 border-slate-200 rounded-xl px-3 py-2">
                  <button type="button" onClick={() => set({ caregiversNeeded: Math.max(1, form.caregiversNeeded - 1) })} disabled={form.caregiversNeeded <= 1}
                    className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                    <span className="text-lg leading-none">−</span>
                  </button>
                  <span className="w-8 text-center text-lg font-semibold text-slate-900">{form.caregiversNeeded}</span>
                  <button type="button" onClick={() => set({ caregiversNeeded: Math.min(4, form.caregiversNeeded + 1) })} disabled={form.caregiversNeeded >= 4}
                    className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                    <span className="text-lg leading-none">+</span>
                  </button>
                  <span className="text-sm text-slate-500">{form.caregiversNeeded === 1 ? 'Caregiver' : 'Caregivers'}</span>
                </div>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1.5">Start Date</label>
                  <input type="date" value={form.startDate} onChange={e => set({ startDate: e.target.value })}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-primary-400" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1.5">End Date</label>
                  <input type="date" value={form.endDate} onChange={e => set({ endDate: e.target.value })}
                    disabled={form.ongoing}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-primary-400 disabled:opacity-40" />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.ongoing} onChange={e => set({ ongoing: e.target.checked })} className="rounded" />
                <span className="text-sm text-slate-600">Ongoing / no end date</span>
              </label>

              {/* Days of week */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-2">Days of Week</label>
                <div className="flex gap-2 flex-wrap">
                  {DAYS.map(d => (
                    <button key={d} type="button" onClick={() => toggleArr('daysOfWeek', d)} className={chip(form.daysOfWeek.includes(d))}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Time of day */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-2">Time of Day</label>
                <div className="flex gap-2 flex-wrap">
                  {TIME_OPTIONS.map(t => (
                    <button key={t.value} type="button" onClick={() => toggleArr('timeOfDay', t.value)}
                      className={chip(form.timeOfDay.includes(t.value))}>
                      {t.label} <span className="opacity-70 font-normal">{t.sub}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <hr className="border-slate-100" />

          {/* ── Care Needs ── */}
          <section>
            <SectionHead icon={<Heart className="w-4 h-4" />} label="Care Needs" />
            <div className="flex flex-wrap gap-2">
              {CARE_TYPES.map(ct => (
                <button key={ct} type="button" onClick={() => toggleArr('careTypes', ct)} className={chip(form.careTypes.includes(ct))}>
                  {ct}
                </button>
              ))}
            </div>
          </section>

          <hr className="border-slate-100" />

          {/* ── Rate ── */}
          <section>
            <SectionHead icon={<DollarSign className="w-4 h-4" />} label="Rate" />
            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.rateFlexible} onChange={e => set({ rateFlexible: e.target.checked })} className="rounded" />
                <span className="text-sm text-slate-600">Rate is flexible / negotiable</span>
              </label>
              {!form.rateFlexible && (
                <div className="relative max-w-[180px]">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                  <input
                    type="number"
                    value={form.rate || ''}
                    onChange={e => set({ rate: Number(e.target.value) })}
                    min={10} max={200}
                    className="w-full pl-7 pr-12 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-primary-400"
                    placeholder="0"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">/hr</span>
                </div>
              )}
            </div>
          </section>

          <hr className="border-slate-100" />

          {/* ── Household ── */}
          <section>
            <SectionHead icon={<Home className="w-4 h-4" />} label="Household" />
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.petsInHome} onChange={e => set({ petsInHome: e.target.checked })} className="rounded" />
                <span className="text-sm text-slate-600">Pets in the home</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.smokingHousehold} onChange={e => set({ smokingHousehold: e.target.checked })} className="rounded" />
                <span className="text-sm text-slate-600">Smoking household</span>
              </label>
            </div>
          </section>

        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-slate-100 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-slate-200 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
              : <><Check className="w-4 h-4" /> Save Changes</>
            }
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
