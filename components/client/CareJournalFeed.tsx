import React, { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { dbService } from '../../services/api';

// Family-visible care journal — entries written by caregivers (web) and by
// Cara's log_journal_entry / create_care_journal_entry tools (care_journal
// collection). Renders nothing until the family has at least one entry.

export interface CareJournalEntry {
  id: string;
  caregiverId?: string;
  caregiverName?: string;
  notes?: string;
  mood?: string | null;
  activities?: string[];
  medsGiven?: boolean | string | null;
  timestamp?: string;
  source?: string;
  wellness?: { mood?: string };
}

// Covers both writer vocabularies: the SMS/care-notes path
// (happy|neutral|agitated|confused|tired) and the MCP tool (good|fair|poor),
// plus legacy values — so an entry from either path renders an emoji.
const MOOD_EMOJI: Record<string, string> = {
  happy: '😊', good: '🙂', calm: '😌', neutral: '😐', fair: '😐',
  tired: '😴', anxious: '😟', sad: '😢', agitated: '😠',
  confused: '😕', poor: '😞',
};

interface CareJournalFeedProps {
  clientId: string;
  limit?: number;
}

export const CareJournalFeed: React.FC<CareJournalFeedProps> = ({ clientId, limit = 10 }) => {
  const [entries, setEntries] = useState<CareJournalEntry[]>([]);

  useEffect(() => {
    if (!clientId) return;
    const unsub = dbService.subscribeCareJournal(clientId, setEntries);
    return () => { try { unsub(); } catch { /* already unsubscribed */ } };
  }, [clientId]);

  if (entries.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-primary-600" />
        Care Journal
      </h2>

      <div className="space-y-3">
        {entries.slice(0, limit).map((e) => {
          const when = e.timestamp
            ? new Date(e.timestamp).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })
            : '';
          // SMS/care-notes entries nest mood under wellness; MCP entries put it top-level.
          const moodValue = e.mood ?? e.wellness?.mood;
          const mood = moodValue ? (MOOD_EMOJI[moodValue.toLowerCase()] ?? '') : '';

          return (
            <div key={e.id} className="bg-white border border-slate-100 rounded-xl p-3 shadow-sm">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-sm font-semibold text-slate-800">
                  {mood && <span className="mr-1">{mood}</span>}
                  {e.caregiverName ?? 'Care visit note'}
                </span>
                <span className="text-xs text-slate-400">{when}</span>
              </div>
              {e.notes && <p className="text-xs text-slate-600">{e.notes}</p>}
              {e.activities && e.activities.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">
                  Activities: {e.activities.join(', ')}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
