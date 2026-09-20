import React, { useState } from 'react';
import { CheckCircle, ChevronDown, ChevronUp } from 'lucide-react';

// The family's read-only view of a visit — the caregiver's notes first (the
// running log written during the visit, shifts.notesLog, then the closing note,
// shifts.completionNotes, as one block), then the task checkboxes per recipient
// (shifts.tasksCompleted, keyed `${ri}_${category}` / `${ri}_${category}_${sub}`),
// collapsed to "7 of 13 done" on a finished visit and open while it is live.
// One component, three places: the Past Bookings detail, the Active Bookings
// row while the visit is in progress, and the dashboard's Active Shift card —
// so what the family sees on the site matches what Evia texts them as it
// happens (the completion recap follows this same order: notes, then tasks).
// Reordered 2026-09-20 (founder): the notes were under 13 task rows.
export interface VisitProgressShift {
  tasksCompleted?: string[];
  careNeeds?: string[];
  careRecipients?: Array<{
    name: string; relationship?: string; age?: string; photoURL?: string | null;
    careNeeds?: string[]; careNeedDetails?: Record<string, string[]>;
  }>;
  notesLog?: Array<{ at: string; text: string; by?: string }>;
  completionNotes?: string | null;
}

const fmtNoteTime = (at: string) => {
  const d = new Date(at);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

export const VisitProgressPanel: React.FC<{ shift: VisitProgressShift; live?: boolean; completionNotes?: string | null }> = ({ shift: s, live, completionNotes }) => {
  const doneRaw: string[] = s.tasksCompleted || [];
  const recipients = s.careRecipients || [];
  const perRecipient = recipients.some(r => (r.careNeeds || []).length > 0);
  const hasTasks = perRecipient || (s.careNeeds || []).length > 0;
  const notes = Array.isArray(s.notesLog) ? s.notesLog : [];
  const closing = (completionNotes ?? s.completionNotes ?? '').trim();
  const [tasksOpen, setTasksOpen] = useState<boolean>(!!live);
  if (!hasTasks && notes.length === 0 && !closing) return null;

  let totalT = 0; let doneT = 0;
  if (perRecipient) {
    recipients.forEach((r, ri) => {
      (r.careNeeds || []).forEach(cat => {
        const subs = (r.careNeedDetails || {})[cat] || [];
        if (subs.length > 0) { totalT += subs.length; doneT += subs.filter((sub: string) => doneRaw.includes(`${ri}_${cat}_${sub}`)).length; }
        else { totalT += 1; doneT += doneRaw.includes(`${ri}_${cat}`) ? 1 : 0; }
      });
    });
  } else {
    totalT = (s.careNeeds || []).length;
    doneT = doneRaw.filter((k: string) => (s.careNeeds || []).includes(k)).length;
  }

  const renderCards = (careNeeds: string[], careNeedDetails: Record<string, string[]>, ri: number) => (
    <div className="space-y-1.5">
      {careNeeds.map((cat, ci) => {
        const subs = careNeedDetails[cat] || [];
        const doneSubCount = subs.filter((sub: string) => doneRaw.includes(`${ri}_${cat}_${sub}`)).length;
        const catDone = subs.length > 0 ? doneSubCount === subs.length : doneRaw.includes(`${ri}_${cat}`);
        return (
          <div key={ci} className="border border-slate-200 rounded-xl overflow-hidden">
            <div className={`flex items-center gap-2 px-3 py-2 ${catDone ? 'bg-green-50' : 'bg-slate-50'}`}>
              <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${catDone ? 'text-green-500' : 'text-slate-300'}`} />
              <p className={`text-xs font-semibold flex-1 ${catDone ? 'text-green-700 line-through' : 'text-primary-600'}`}>{cat}</p>
              {subs.length > 0 && doneSubCount > 0 && (
                <span className={`text-[10px] font-semibold ${catDone ? 'text-green-600' : 'text-slate-400'}`}>{doneSubCount}/{subs.length}</span>
              )}
            </div>
            {subs.length > 0 && (
              <div className="px-3 py-2 space-y-1">
                {subs.map((sub: string, si: number) => {
                  const done = doneRaw.includes(`${ri}_${cat}_${sub}`);
                  return (
                    <div key={si} className={`flex items-center gap-2 text-xs font-medium ${done ? 'text-green-700' : 'text-slate-400'}`}>
                      <CheckCircle className={`w-3.5 h-3.5 flex-shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                      {sub}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Notes first — the caregiver's log during the visit, then the closing note, one block */}
      {(notes.length > 0 || closing || live) && (
        <div className="p-3 bg-white border border-slate-200 rounded-xl">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Visit Notes</p>
          {notes.length > 0 || closing ? (
            <div className="space-y-1">
              {notes.map((n, i) => (
                <p key={i} className="text-xs text-slate-600">
                  <span className="text-slate-400 mr-1.5">{fmtNoteTime(n.at)}</span>{n.text}
                </p>
              ))}
              {closing && (
                <p className={`text-xs text-slate-700 ${notes.length > 0 ? 'pt-1.5 mt-1.5 border-t border-slate-100' : ''}`}>
                  <span className="text-slate-400 mr-1.5">Closing note</span>{closing}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic">No notes yet — they appear here as your caregiver adds them.</p>
          )}
        </div>
      )}

      {/* Tasks — a one-line summary on a finished visit, the full checklist while live or when opened */}
      {hasTasks && (
        <div>
          <button
            type="button"
            onClick={() => setTasksOpen(o => !o)}
            className="w-full flex items-center justify-between mb-2 text-left"
            aria-expanded={tasksOpen}
          >
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{live ? 'Tasks so far' : 'Tasks'}</p>
            <span className="flex items-center gap-2">
              {totalT > 0 && (
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${doneT === totalT ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                  {doneT} of {totalT} done
                </span>
              )}
              {tasksOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
            </span>
          </button>
          {tasksOpen && (perRecipient
            ? recipients.map((r, ri) => {
                const needs = r.careNeeds || [];
                if (needs.length === 0) return null;
                return (
                  <div key={ri} className="mb-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="w-5 h-5 rounded-full overflow-hidden bg-primary-100 shrink-0 flex items-center justify-center">
                        {r.photoURL
                          ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                          : <span className="text-[9px] font-bold text-primary-600">{String(r.name || '').split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase()}</span>}
                      </div>
                      <p className="text-xs font-semibold text-slate-600">{r.name}{r.relationship ? ` · ${r.relationship}` : ''}{r.age ? ` · Age ${r.age}` : ''}</p>
                    </div>
                    {renderCards(needs, r.careNeedDetails || {}, ri)}
                  </div>
                );
              })
            : renderCards(s.careNeeds || [], {}, 0))}
        </div>
      )}
    </div>
  );
};
