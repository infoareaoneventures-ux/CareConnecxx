import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WeeklySchedule, TimeSlot } from '../../types';

type DayKey = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

const DAYS: DayKey[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hourLabel(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// --- Adapters: accept either WeeklySchedule or the legacy "Sun/Morning" shape --------

function legacyPeriodToHours(period: string): [number, number] | null {
  const p = period.toLowerCase();
  if (p.startsWith('morning')) return [6, 12];
  if (p.startsWith('afternoon')) return [12, 18];
  if (p.startsWith('evening')) return [18, 24];
  return null;
}

const LEGACY_DAY_MAP: Record<string, DayKey> = {
  sun: 'sunday', sunday: 'sunday',
  mon: 'monday', monday: 'monday',
  tue: 'tuesday', tuesday: 'tuesday',
  wed: 'wednesday', wednesday: 'wednesday',
  thu: 'thursday', thursday: 'thursday',
  fri: 'friday', friday: 'friday',
  sat: 'saturday', saturday: 'saturday',
};

function normalizeToSet(value: any): Set<string> {
  const set = new Set<string>();
  if (!value || typeof value !== 'object') return set;

  for (const rawKey of Object.keys(value)) {
    const day = LEGACY_DAY_MAP[rawKey.toLowerCase()];
    if (!day) continue;
    const entries = value[rawKey];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      // WeeklySchedule shape: { start: "09:00", end: "17:00" }
      if (entry && typeof entry === 'object' && typeof entry.start === 'string' && typeof entry.end === 'string') {
        const startH = parseInt(entry.start.split(':')[0], 10);
        const endH = parseInt(entry.end.split(':')[0], 10);
        if (Number.isFinite(startH) && Number.isFinite(endH)) {
          const effectiveEnd = endH === 0 ? 24 : endH;
          for (let h = startH; h < effectiveEnd; h++) set.add(`${day}:${h}`);
        }
        continue;
      }
      // Legacy period shape: string like "Morning"
      if (typeof entry === 'string') {
        const range = legacyPeriodToHours(entry);
        if (range) {
          const [s, e] = range;
          for (let h = s; h < e; h++) set.add(`${day}:${h}`);
        }
        continue;
      }
    }
  }
  return set;
}

function setToSchedule(set: Set<string>): WeeklySchedule {
  const result: WeeklySchedule = {
    monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
  };
  for (const day of DAYS) {
    const hours: number[] = [];
    for (let h = 0; h < 24; h++) if (set.has(`${day}:${h}`)) hours.push(h);
    if (hours.length === 0) continue;

    let start = hours[0];
    let prev = hours[0];
    for (let i = 1; i <= hours.length; i++) {
      if (i === hours.length || hours[i] !== prev + 1) {
        const endHour = prev + 1;
        const slot: TimeSlot = {
          start: `${String(start).padStart(2, '0')}:00`,
          end: `${String(endHour === 24 ? 0 : endHour).padStart(2, '0')}:00`,
        };
        result[day].push(slot);
        if (i < hours.length) {
          start = hours[i];
          prev = hours[i];
        }
      } else {
        prev = hours[i];
      }
    }
  }
  return result;
}

// --- Component ---------------------------------------------------------------------

interface DragSelectWeekGridProps {
  value: any; // accepts WeeklySchedule or the legacy Record<string, string[]> shape
  onChange: (next: WeeklySchedule) => void;
  startHour?: number; // default 0 (midnight)
  endHour?: number;   // default 24 (midnight next day)
}

export const DragSelectWeekGrid: React.FC<DragSelectWeekGridProps> = ({
  value,
  onChange,
  startHour = 0,
  endHour = 24,
}) => {
  const [cells, setCells] = useState<Set<string>>(() => normalizeToSet(value));
  const dragMode = useRef<'add' | 'remove' | null>(null);
  const lastEmittedRef = useRef<Set<string>>(cells);

  // Sync when parent value changes (e.g., load from Firestore)
  useEffect(() => {
    setCells(normalizeToSet(value));
  }, [value]);

  // Commit (convert to WeeklySchedule and call onChange) when drag ends or cells change via click
  const commit = (next: Set<string>) => {
    lastEmittedRef.current = next;
    onChange(setToSchedule(next));
  };

  const applyTo = (key: string, mode: 'add' | 'remove') => {
    setCells((prev) => {
      const next = new Set(prev);
      if (mode === 'add') next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handlePointerDown = (day: DayKey, hour: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    const key = `${day}:${hour}`;
    const mode: 'add' | 'remove' = cells.has(key) ? 'remove' : 'add';
    dragMode.current = mode;
    applyTo(key, mode);
  };

  const handlePointerEnter = (day: DayKey, hour: number) => () => {
    if (!dragMode.current) return;
    applyTo(`${day}:${hour}`, dragMode.current);
  };

  useEffect(() => {
    const onUp = () => {
      if (dragMode.current) {
        dragMode.current = null;
        commit(cells);
      }
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // Re-register every render so `cells` in onUp is fresh
  });

  const hours = useMemo(() => {
    const arr: number[] = [];
    for (let h = startHour; h < endHour; h++) arr.push(h);
    return arr;
  }, [startHour, endHour]);

  const selectAllDay = (day: DayKey) => {
    const next = new Set(cells);
    const allOn = hours.every((h) => next.has(`${day}:${h}`));
    hours.forEach((h) => {
      const k = `${day}:${h}`;
      if (allOn) next.delete(k); else next.add(k);
    });
    setCells(next);
    commit(next);
  };

  const clearAll = () => {
    const next = new Set<string>();
    setCells(next);
    commit(next);
  };

  const applyPreset = (preset: 'weekday-daytime' | 'weekday-evenings' | 'weekend-daytime') => {
    const next = new Set(cells);
    const weekdays: DayKey[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    const weekends: DayKey[] = ['saturday', 'sunday'];
    const add = (days: DayKey[], hs: number[]) => days.forEach((d) => hs.forEach((h) => next.add(`${d}:${h}`)));
    if (preset === 'weekday-daytime') add(weekdays, Array.from({ length: 8 }, (_, i) => 9 + i)); // 9-5
    if (preset === 'weekday-evenings') add(weekdays, [17, 18, 19, 20, 21]);
    if (preset === 'weekend-daytime') add(weekends, Array.from({ length: 8 }, (_, i) => 9 + i));
    setCells(next);
    commit(next);
  };

  const totalSelected = cells.size;

  return (
    <div className="select-none" style={{ touchAction: 'none' }}>
      {/* Preset + clear toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => applyPreset('weekday-daytime')}
          className="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
        >
          Weekday 9–5
        </button>
        <button
          type="button"
          onClick={() => applyPreset('weekday-evenings')}
          className="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
        >
          Weekday evenings
        </button>
        <button
          type="button"
          onClick={() => applyPreset('weekend-daytime')}
          className="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
        >
          Weekend days
        </button>
        <div className="flex-1" />
        <span className="text-xs text-slate-500">{totalSelected} hour{totalSelected === 1 ? '' : 's'}/week</span>
        <button
          type="button"
          onClick={clearAll}
          className="px-3 py-1 rounded-full text-xs font-medium text-rose-600 hover:bg-rose-50"
        >
          Clear all
        </button>
      </div>

      {/* Grid */}
      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
        {/* Header row: day labels */}
        <div className="grid" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
          <div className="bg-slate-50 border-b border-slate-200" />
          {DAYS.map((day, i) => (
            <button
              key={day}
              type="button"
              onClick={() => selectAllDay(day)}
              className="text-center text-xs font-semibold text-slate-600 py-2 border-b border-l border-slate-200 hover:bg-slate-50"
              title={`Toggle all ${DAY_LABELS[i]}`}
            >
              {DAY_LABELS[i]}
            </button>
          ))}
        </div>

        {/* Hour rows */}
        <div className="max-h-[440px] overflow-y-auto">
          {hours.map((h) => (
            <div key={h} className="grid" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
              <div className="text-right pr-2 py-0 text-[10px] text-slate-400 border-r border-slate-100 flex items-center justify-end h-7">
                {hourLabel(h)}
              </div>
              {DAYS.map((day) => {
                const key = `${day}:${h}`;
                const selected = cells.has(key);
                return (
                  <div
                    key={key}
                    onPointerDown={handlePointerDown(day, h)}
                    onPointerEnter={handlePointerEnter(day, h)}
                    className={`h-7 border-b border-l border-slate-100 cursor-pointer transition-colors ${
                      selected ? 'bg-primary-500 hover:bg-primary-600' : 'bg-white hover:bg-primary-50'
                    }`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-slate-500 mt-2">
        Click and drag to select available hours. Click a day label to toggle the whole day.
      </p>
    </div>
  );
};
