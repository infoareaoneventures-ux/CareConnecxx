import React from 'react';

// The caregiver's notes for one visit, everywhere a finished shift is shown:
// the running log written during the visit (shifts.notesLog) and the closing
// note (shifts.completionNotes) as one block. Live 2026-09-21 (founder): the
// family's Past Bookings card showed both, but the caregiver's Past Bookings
// card, the caregiver's Completed Shift modal, the Calendar day sheet and the
// family's Timesheets card showed only the closing note — same shift, same
// fields, different pictures. One component so they can't drift again.
export interface VisitNotesBlockProps {
  notesLog?: Array<{ at: string; text: string; by?: string }> | null;
  completionNotes?: string | null;
  /** Uppercase tracking label, as the Timesheets card styles its section headings. */
  uppercase?: boolean;
  className?: string;
}

const fmtNoteTime = (at: string) => {
  const d = new Date(at);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

export const VisitNotesBlock: React.FC<VisitNotesBlockProps> = ({ notesLog, completionNotes, uppercase, className }) => {
  const notes = Array.isArray(notesLog) ? notesLog.filter(n => n && typeof n.text === 'string' && n.text.trim()) : [];
  const closing = (completionNotes ?? '').trim();
  if (notes.length === 0 && !closing) return null;
  const label = `text-xs font-semibold text-slate-500 mb-1${uppercase ? ' uppercase tracking-wide' : ''}`;
  return (
    <div className={className ?? 'p-3 bg-white border border-slate-200 rounded-xl'}>
      {notes.length > 0 && (
        <>
          <p className={label}>Visit notes</p>
          <div className="space-y-1 mb-2">
            {notes.map((n, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="text-slate-400 shrink-0 w-14">{fmtNoteTime(n.at)}</span>
                <span className="text-slate-700">{n.text}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {closing && (
        <div className={notes.length > 0 ? 'pt-2 border-t border-slate-100' : ''}>
          <p className={label}>{notes.length > 0 ? 'Closing note' : 'Caregiver Notes'}</p>
          <p className="text-xs text-slate-600">{closing}</p>
        </div>
      )}
    </div>
  );
};
