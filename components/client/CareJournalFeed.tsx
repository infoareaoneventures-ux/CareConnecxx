import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, BookOpen, Loader2, Smile, Meh, Frown, Heart,
  CheckCircle, XCircle, Clock, Camera, AlignLeft, User, Calendar
} from 'lucide-react';
import { CareJournalEntry, ViewType } from '../../types';
import { dbService, authService } from '../../services/api';
import { ClientNavigation } from './ClientNavigation';

interface CareJournalFeedProps {
  onNavigate: (view: ViewType) => void;
}

const MOOD_CONFIG = {
  great: { label: 'Doing great',      emoji: '😊', color: 'text-green-700',  bg: 'bg-green-50',  border: 'border-green-200' },
  good:  { label: 'Doing well',       emoji: '🙂', color: 'text-primary-700',   bg: 'bg-primary-50',   border: 'border-primary-200'  },
  ok:    { label: 'So-so',            emoji: '😐', color: 'text-accent-700',  bg: 'bg-accent-50',  border: 'border-accent-200' },
  poor:  { label: 'Needs attention',  emoji: '😟', color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200'   },
};

function formatDateLabel(dateStr: string): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const d = new Date(dateStr + 'T12:00:00'); // noon avoids timezone shift
  const todayStr = today.toISOString().split('T')[0];
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  if (dateStr === todayStr) return 'Today';
  if (dateStr === yesterdayStr) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function getEntryDate(entry: CareJournalEntry): string {
  try {
    return (entry.timestamp || entry.checkInTime || '').split('T')[0];
  } catch {
    return 'unknown';
  }
}

const WellnessDot: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => (
  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
    ok ? 'bg-primary-50 text-primary-700 border border-primary-200' : 'bg-slate-50 text-slate-400 border border-slate-200'
  }`}>
    {ok
      ? <CheckCircle className="w-3 h-3 flex-shrink-0" />
      : <XCircle className="w-3 h-3 flex-shrink-0" />}
    {label}
  </span>
);

const EntryCard: React.FC<{ entry: CareJournalEntry }> = ({ entry }) => {
  const mood = MOOD_CONFIG[entry.wellness?.mood || 'good'];

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Card header */}
      <div className={`px-4 py-3 flex items-center justify-between ${mood.bg} border-b ${mood.border}`}>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center border border-slate-200 flex-shrink-0">
            <User className="w-4 h-4 text-slate-500" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-700">Caregiver visit</p>
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <Clock className="w-3 h-3" />
              {entry.checkInTime ? formatTime(entry.checkInTime) : '—'}
              {entry.checkOutTime && <> – {formatTime(entry.checkOutTime)}</>}
            </div>
          </div>
        </div>
        <span className={`text-sm px-2.5 py-0.5 rounded-full font-semibold ${mood.color} ${mood.bg} border ${mood.border}`}>
          {mood.emoji} {mood.label}
        </span>
      </div>

      {/* Card body */}
      <div className="px-4 py-3 space-y-3">
        {/* Wellness row */}
        <div className="flex flex-wrap gap-1.5">
          <WellnessDot ok={!!entry.wellness?.ateWell}   label="Ate well" />
          <WellnessDot ok={!!entry.wellness?.tookMeds}  label="Took meds" />
          <WellnessDot ok={!!entry.wellness?.wasActive} label="Was active" />
        </div>

        {/* Activities */}
        {entry.activities && entry.activities.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.activities.map((a, i) => (
              <span key={i} className="text-xs px-2 py-0.5 bg-accent-50 text-accent-700 border border-accent-100 rounded-full font-medium capitalize">
                {a}
              </span>
            ))}
          </div>
        )}

        {/* Notes */}
        {entry.notes && (
          <div className="flex gap-2 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
            <AlignLeft className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-slate-600 italic leading-relaxed">"{entry.notes}"</p>
          </div>
        )}

        {/* Photos */}
        {entry.photos && entry.photos.length > 0 && (
          <div className="flex gap-2">
            <Camera className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
            <div className="flex gap-1.5 flex-wrap">
              {entry.photos.slice(0, 4).map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt={`Visit photo ${i + 1}`}
                  className="w-14 h-14 rounded-lg object-cover border border-slate-200"
                />
              ))}
              {entry.photos.length > 4 && (
                <div className="w-14 h-14 rounded-lg bg-slate-100 flex items-center justify-center text-xs font-semibold text-slate-500 border border-slate-200">
                  +{entry.photos.length - 4}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const CareJournalFeed: React.FC<CareJournalFeedProps> = ({ onNavigate }) => {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<CareJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const currentUser = authService.getCurrentUser();

  useEffect(() => {
    if (!currentUser?.uid) { navigate('/login'); return; }
    const unsub = dbService.subscribeToCareJournal(currentUser.uid, (updated) => {
      setEntries(updated);
      setLoading(false);
    });
    // Fallback: if subscription doesn't fire within 3s, stop loading
    const timeout = setTimeout(() => setLoading(false), 3000);
    return () => { unsub(); clearTimeout(timeout); };
  }, [currentUser?.uid]);

  // Group by date, newest first
  const grouped = entries.reduce<Record<string, CareJournalEntry[]>>((acc, entry) => {
    const date = getEntryDate(entry);
    if (!acc[date]) acc[date] = [];
    acc[date].push(entry);
    return acc;
  }, {});
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientNavigation />

      <main className="max-w-2xl mx-auto px-4 py-6 pb-24">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => navigate('/client/dashboard')}
            className="p-2 -ml-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <BookOpen className="w-6 h-6 text-primary-600" />
              Care Journal
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">Daily updates from your caregiver after every visit</p>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
            <p className="text-sm text-slate-400">Loading journal entries…</p>
          </div>
        ) : entries.length === 0 ? (
          /* Empty state */
          <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center shadow-sm">
            <div className="w-16 h-16 bg-primary-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <BookOpen className="w-8 h-8 text-primary-400" />
            </div>
            <h2 className="text-lg font-bold text-slate-900 mb-2">No journal entries yet</h2>
            <p className="text-sm text-slate-500 max-w-xs mx-auto leading-relaxed">
              After each visit, your caregiver will post an update here — mood, meals, medications, activities, and notes.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {['Mood check', 'Meals & meds', 'Activities', 'Caregiver notes', 'Photos'].map(tag => (
                <span key={tag} className="text-xs px-3 py-1 bg-primary-50 text-primary-700 border border-primary-100 rounded-full font-medium">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {sortedDates.map(date => (
              <section key={date}>
                {/* Date header */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary-600" />
                    <h2 className="text-sm font-bold text-slate-700">{formatDateLabel(date)}</h2>
                  </div>
                  <div className="flex-1 h-px bg-slate-200" />
                  <span className="text-xs text-slate-400">{grouped[date].length} visit{grouped[date].length !== 1 ? 's' : ''}</span>
                </div>

                {/* Entry cards for this date */}
                <div className="space-y-3">
                  {grouped[date].map(entry => (
                    <EntryCard key={entry.id} entry={entry} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};
