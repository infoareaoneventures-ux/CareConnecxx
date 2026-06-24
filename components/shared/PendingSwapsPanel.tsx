import React from 'react';
import { Repeat } from 'lucide-react';
import type { PendingSwap } from '../../services/shiftSwap';

interface PendingSwapsPanelProps {
  swaps: PendingSwap[];
  title: string;
  /** Optional one-line description shown under the title. */
  subtitle?: string;
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Finding a caregiver',
  pending: 'Awaiting response',
  accepted: 'Accepted',
};

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-amber-50 text-amber-700',
  pending: 'bg-amber-50 text-amber-700',
  accepted: 'bg-green-50 text-green-700',
};

/**
 * Read-only live view of pending shift swaps (U7). Renders nothing when there
 * are no active swaps, so it adds no empty-box clutter to a dashboard.
 */
export const PendingSwapsPanel: React.FC<PendingSwapsPanelProps> = ({ swaps, title, subtitle }) => {
  if (!swaps || swaps.length === 0) return null;

  return (
    <div className="bg-white border border-slate-100 rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-1">
        <Repeat className="w-4 h-4 text-slate-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      </div>
      {subtitle && <p className="text-xs text-slate-500 mb-3">{subtitle}</p>}
      <ul className="space-y-2">
        {swaps.map(s => (
          <li
            key={`${s.source}:${s.id}`}
            className="flex items-center justify-between gap-3 bg-slate-50 rounded-lg px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm text-slate-700 truncate">
                {s.date ? `Shift on ${s.date}${s.time ? ` at ${s.time}` : ''}` : 'Shift change'}
              </p>
            </div>
            <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLE[s.status] ?? 'bg-slate-100 text-slate-600'}`}>
              {STATUS_LABEL[s.status] ?? s.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};
