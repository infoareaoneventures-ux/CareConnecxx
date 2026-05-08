import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, BookOpen, Loader2, Smile, Meh, Frown, Heart,
  CheckCircle, XCircle, Clock, Camera, AlignLeft, User, Calendar,
  Pencil, Trash2, Save, X
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

const ACTIVITIES = [
  'breakfast', 'lunch', 'dinner', 'medications',
  'walk / exercise', 'outing', 'companionship', 'housekeeping',
];

const MOOD_OPTIONS: Array<CareJournalEntry['wellness']['mood']> = ['great', 'good', 'ok', 'poor'];

interface EntryCardProps {
  entry: CareJournalEntry;
  currentUserId: string | null;
  isEditing: boolean;
  onEditStart: () => void;
  onEditSave: (updates: Partial<Pick<CareJournalEntry, 'notes' | 'wellness' | 'activities'>>) => void;
  onEditCancel: () => void;
  onDelete: (id: string) => void;
}

const EntryCard: React.FC<EntryCardProps> = ({
  entry, currentUserId, isEditing, onEditStart, onEditSave, onEditCancel, onDelete,
}) => {
  const mood = MOOD_CONFIG[entry.wellness?.mood || 'good'];
  const canEdit = currentUserId === entry.caregiverId;

  // Edit state
  const [editMood, setEditMood]           = useState<CareJournalEntry['wellness']['mood']>(entry.wellness?.mood || 'good');
  const [editWellness, setEditWellness]   = useState({
    ateWell:   !!entry.wellness?.ateWell,
    tookMeds:  !!entry.wellness?.tookMeds,
    wasActive: !!entry.wellness?.wasActive,
    sleptWell: !!entry.wellness?.sleptWell,
  });
  const [editActivities, setEditActivities] = useState<string[]>(entry.activities ?? []);
  const [editNotes, setEditNotes]           = useState(entry.notes ?? '');
  const [saving, setSaving]                 = useState(false);
  const [confirmDelete, setConfirmDelete]   = useState(false);
  const [deleting, setDeleting]             = useState(false);

  function toggleActivity(a: string) {
    setEditActivities(prev =>
      prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      onEditSave({
        notes: editNotes.trim(),
        wellness: { ...editWellness, mood: editMood },
        activities: editActivities,
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await dbService.deleteCareJournalEntry(entry.id, entry.photos ?? []);
      onDelete(entry.id);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (isEditing) {
    return (
      <div className="bg-white rounded-xl border border-primary-300 shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-primary-50 border-b border-primary-200 flex items-center justify-between">
          <span className="text-xs font-semibold text-primary-700">Editing entry</span>
          <div className="flex gap-2">
            <button onClick={onEditCancel} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded-lg border border-slate-200 bg-white">
              <X className="w-3 h-3" /> Cancel
            </button>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 text-xs text-white bg-primary-600 hover:bg-primary-700 px-2 py-1 rounded-lg disabled:opacity-50">
              <Save className="w-3 h-3" /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <div className="px-4 py-3 space-y-4">
          {/* Mood */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Mood</p>
            <div className="flex gap-2 flex-wrap">
              {MOOD_OPTIONS.map(m => {
                const cfg = MOOD_CONFIG[m];
                return (
                  <button
                    key={m}
                    onClick={() => setEditMood(m)}
                    className={`text-xs px-2.5 py-1 rounded-full border font-semibold transition-colors ${
                      editMood === m ? `${cfg.color} ${cfg.bg} ${cfg.border}` : 'text-slate-400 border-slate-200 bg-white'
                    }`}
                  >
                    {cfg.emoji} {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* Wellness toggles */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Wellness</p>
            <div className="flex flex-wrap gap-2">
              {([
                ['ateWell',   'Ate well'],
                ['tookMeds',  'Took meds'],
                ['wasActive', 'Was active'],
                ['sleptWell', 'Slept well'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setEditWellness(w => ({ ...w, [key]: !w[key] }))}
                  className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium transition-colors ${
                    editWellness[key]
                      ? 'bg-primary-50 text-primary-700 border-primary-200'
                      : 'bg-slate-50 text-slate-400 border-slate-200'
                  }`}
                >
                  {editWellness[key] ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                  {label}
                </button>
              ))}
            </div>
          </div>
          {/* Activities */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Activities</p>
            <div className="flex flex-wrap gap-1.5">
              {ACTIVITIES.map(a => (
                <button
                  key={a}
                  onClick={() => toggleActivity(a)}
                  className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize transition-colors ${
                    editActivities.includes(a)
                      ? 'bg-accent-50 text-accent-700 border-accent-200'
                      : 'bg-white text-slate-400 border-slate-200'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
          {/* Notes */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Notes</p>
            <textarea
              value={editNotes}
              onChange={e => setEditNotes(e.target.value)}
              maxLength={2000}
              rows={3}
              className="w-full text-xs text-slate-700 border border-slate-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-primary-300"
              placeholder="Add notes about the visit…"
            />
            <p className="text-right text-xs text-slate-400 mt-0.5">{editNotes.length}/2000</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Card header */}
      <div className={`px-4 py-3 flex items-center justify-between ${mood.bg} border-b ${mood.border}`}>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center border border-slate-200 flex-shrink-0">
            <User className="w-4 h-4 text-slate-500" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-700">
              Caregiver visit
              {entry.updatedAt && <span className="ml-1.5 font-normal text-slate-400">(edited)</span>}
            </p>
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <Clock className="w-3 h-3" />
              {entry.checkInTime ? formatTime(entry.checkInTime) : '—'}
              {entry.checkOutTime && <> – {formatTime(entry.checkOutTime)}</>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-sm px-2.5 py-0.5 rounded-full font-semibold ${mood.color} ${mood.bg} border ${mood.border}`}>
            {mood.emoji} {mood.label}
          </span>
          {canEdit && (
            <div className="flex gap-1 ml-1">
              <button
                onClick={onEditStart}
                title="Edit entry"
                className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-white rounded-lg transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                title="Delete entry"
                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-white rounded-lg transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-100 flex items-center justify-between gap-3">
          <p className="text-xs text-red-700 font-medium">Delete this entry? This can't be undone.</p>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => setConfirmDelete(false)} className="text-xs text-slate-600 px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50">
              Cancel
            </button>
            <button onClick={handleDelete} disabled={deleting} className="text-xs text-white bg-red-500 hover:bg-red-600 px-2 py-1 rounded-lg disabled:opacity-50">
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}

      {/* Card body */}
      <div className="px-4 py-3 space-y-3">
        {/* Wellness row */}
        <div className="flex flex-wrap gap-1.5">
          <WellnessDot ok={!!entry.wellness?.ateWell}   label="Ate well" />
          <WellnessDot ok={!!entry.wellness?.tookMeds}  label="Took meds" />
          <WellnessDot ok={!!entry.wellness?.wasActive} label="Was active" />
          {entry.wellness?.sleptWell !== undefined && (
            <WellnessDot ok={!!entry.wellness.sleptWell} label="Slept well" />
          )}
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
  const [entries, setEntries]         = useState<CareJournalEntry[]>([]);
  const [loading, setLoading]         = useState(true);
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [healthSignals, setHealthSignals] = useState<Record<string, { severity: string; signals: string[] }>>({});
  const currentUser = authService.getCurrentUser();

  useEffect(() => {
    if (!currentUser?.uid) { navigate('/login'); return; }
    const unsub = dbService.subscribeToCareJournal(currentUser.uid, (updated) => {
      setEntries(updated);
      setLoading(false);
      // Load health signals for visible entries (Firestore `in` limit: 10)
      const ids = updated.slice(0, 10).map(e => e.id).filter(Boolean);
      if (ids.length > 0) {
        dbService.getHealthSignalsForEntries(ids).then(setHealthSignals).catch(() => {});
      }
    });
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
                  {grouped[date].map(entry => {
                    const signal = healthSignals[entry.id];
                    return (<>
                    {signal?.severity === 'flag' && (
                      <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 -mb-1 text-xs text-amber-800">
                        <span className="mt-0.5">⚠️</span>
                        <span><span className="font-semibold">Worth discussing with a doctor:</span> {signal.signals.join(', ')}</span>
                      </div>
                    )}
                    {signal?.severity === 'watch' && (
                      <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2 -mb-1 text-xs text-blue-700">
                        <span>👀</span>
                        <span>Something to keep an eye on from this visit.</span>
                      </div>
                    )}
                    <EntryCard
                      key={entry.id}
                      entry={entry}
                      currentUserId={currentUser?.uid ?? null}
                      isEditing={editingId === entry.id}
                      onEditStart={() => setEditingId(entry.id)}
                      onEditSave={async (updates) => {
                        await dbService.updateCareJournalEntry(entry.id, updates);
                        setEntries(prev => prev.map(e =>
                          e.id === entry.id
                            ? { ...e, ...updates, updatedAt: new Date().toISOString() }
                            : e
                        ));
                        setEditingId(null);
                      }}
                      onEditCancel={() => setEditingId(null)}
                      onDelete={(id) => setEntries(prev => prev.filter(e => e.id !== id))}
                    />
                    </>);
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};
