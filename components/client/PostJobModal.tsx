import React, { useState } from 'react';
import { X, Briefcase, Check, Loader2 } from 'lucide-react';
import { dbService, authService } from '../../services/api';

interface PostJobModalProps {
  onClose: () => void;
  onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const CARE_TYPES = [
  'Dementia Care', 'Mobility / Lifting', 'Companionship', 'Meal Prep',
  'Housekeeping', 'Transportation', 'Medication Reminders', 'Bathing / Hygiene',
];

const SCHEDULE_OPTIONS = ['One-time', 'Weekly', 'Daily', 'Mon–Fri', 'Weekends'];

export const PostJobModal: React.FC<PostJobModalProps> = ({ onClose, onShowToast }) => {
  const [careTypes, setCareTypes] = useState<string[]>([]);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState('4');
  const [scheduleType, setScheduleType] = useState('One-time');
  const [budget, setBudget] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const toggleCareType = (ct: string) => {
    setCareTypes(prev =>
      prev.includes(ct) ? prev.filter(c => c !== ct) : [...prev, ct]
    );
  };

  const handleSubmit = async () => {
    if (careTypes.length === 0) {
      onShowToast('Please select at least one care type', 'error');
      return;
    }
    if (!date) {
      onShowToast('Please select a preferred date', 'error');
      return;
    }

    const user = authService.getCurrentUser();
    if (!user?.uid) {
      onShowToast('Please sign in to post a job', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      await dbService.createJobPost(
        {
          clientName: user.displayName || 'Client',
          title: `${careTypes.slice(0, 2).join(' + ')} — ${scheduleType}`,
          careTypes,
          preferredDate: date,
          startTime: time,
          minHoursPerWeek: Number(duration),
          jobFrequency: scheduleType as 'one-time' | 'part-time' | 'full-time',
          rate: Number(budget),
          notes,
          status: 'open',
          location: 'Santa Clara County, CA',
        },
        user.uid
      );
      setSubmitted(true);
      onShowToast('Job posted! Caregivers can now apply.', 'success');
    } catch (err) {
      console.error('Failed to post job:', err);
      onShowToast('Failed to post job. Please try again.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
              <Briefcase className="w-4 h-4 text-primary-600" />
            </div>
            <h2 className="text-lg font-bold text-slate-900">Post a Care Job</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {submitted ? (
          <div className="p-8 text-center">
            <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-primary-600" />
            </div>
            <h3 className="text-xl font-bold text-slate-900 mb-2">Job Posted!</h3>
            <p className="text-slate-500 text-sm mb-6">
              Qualified caregivers in Santa Clara County can now see and apply to your job. We'll notify you when someone applies.
            </p>
            <button
              onClick={onClose}
              className="bg-primary-600 text-white font-semibold px-6 py-2.5 rounded-xl hover:bg-primary-700 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Care Types */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                What care is needed? <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {CARE_TYPES.map(ct => (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => toggleCareType(ct)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl border text-sm font-medium transition-all text-left ${
                      careTypes.includes(ct)
                        ? 'bg-primary-50 border-primary-500 text-primary-700'
                        : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
                    }`}
                  >
                    {ct}
                    {careTypes.includes(ct) && <Check className="w-4 h-4 flex-shrink-0" />}
                  </button>
                ))}
              </div>
            </div>

            {/* Date + Time */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  Preferred Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={date}
                  min={new Date().toISOString().split('T')[0]}
                  onChange={e => setDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Preferred Time</label>
                <input
                  type="time"
                  value={time}
                  onChange={e => setTime(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            {/* Duration + Schedule type */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Duration (hours)</label>
                <select
                  value={duration}
                  onChange={e => setDuration(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {['2', '3', '4', '5', '6', '8', '10', '12'].map(h => (
                    <option key={h} value={h}>{h} hrs</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Schedule Type</label>
                <select
                  value={scheduleType}
                  onChange={e => setScheduleType(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {SCHEDULE_OPTIONS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Budget input */}
            <div>
              <label className="text-sm font-semibold text-slate-700 block mb-1">Hourly Budget</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-semibold">$</span>
                <input
                  type="number"
                  min={1}
                  value={budget}
                  onChange={e => setBudget(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="e.g. 32"
                  className="w-full pl-8 pr-14 py-3 border-2 border-slate-200 rounded-xl text-lg font-semibold text-slate-900 focus:outline-none focus:border-primary-500"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-medium">/hr</span>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Notes for caregivers <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Any specific requirements, health conditions to be aware of, location details..."
                rows={3}
                className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              />
            </div>

            {/* Summary */}
            {careTypes.length > 0 && date && (
              <div className="p-3 bg-primary-50 rounded-xl border border-primary-200 text-sm">
                <p className="font-semibold text-primary-800 mb-1">Your job post:</p>
                <p className="text-primary-700">{careTypes.join(', ')}</p>
                <p className="text-primary-600 text-xs mt-1">{date}{time ? ` at ${time}` : ''} · {duration} hrs · ${budget}/hr · {scheduleType}</p>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="w-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Posting...</> : 'Post Job — Free'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default PostJobModal;
