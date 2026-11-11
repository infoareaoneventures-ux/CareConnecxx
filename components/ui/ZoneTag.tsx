import React from 'react';
import { careZoneOf, zoneAbbr, DEFAULT_CARE_TZ } from '../../utils/careTime';

/**
 * The zone name beside a visit's time: " CT" for a visit at a Chicago address, nothing for Pacific (so every existing
 * screen reads as before). A visit's times are wall clock AT ITS CARE LOCATION, and this says which one (2026-11-09,
 * all U.S. zones). Pass the visit / booking record.
 */
export const ZoneTag: React.FC<{ visit: { timeZone?: string; address?: string; zipCode?: string } | null | undefined; className?: string }> = ({ visit, className }) => {
  const tz = careZoneOf(visit as any);
  if (tz === DEFAULT_CARE_TZ) return null;
  return <span className={className ?? 'text-slate-400'} title={`Times are in the care location's time zone (${tz.replace('_', ' ')})`}> {zoneAbbr(tz)}</span>;
};
