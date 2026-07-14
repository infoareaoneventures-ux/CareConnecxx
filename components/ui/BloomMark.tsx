import React from 'react';

/**
 * Evia brand mark — "Bloom" (six-petal daisy, open center).
 * Approved 2026-07-13; replaces the lucide Activity pulse icon in all brand
 * lockups. Inherits color from CSS `currentColor` so existing text-* classes
 * keep working; the center hole is truly transparent (mask), so it works on
 * any background. Never add a face to this mark (founder decision).
 */
export const BloomMark: React.FC<{ className?: string }> = ({ className }) => {
  const maskId = React.useId();
  return (
    <svg viewBox="0 0 120 120" className={className} fill="currentColor" aria-hidden="true">
      <defs>
        <mask id={maskId}>
          <rect width="120" height="120" fill="#fff" />
          <circle cx="60" cy="60" r="20" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <circle cx="60" cy="27" r="24" />
        <circle cx="88.6" cy="43.5" r="24" />
        <circle cx="88.6" cy="76.5" r="24" />
        <circle cx="60" cy="93" r="24" />
        <circle cx="31.4" cy="76.5" r="24" />
        <circle cx="31.4" cy="43.5" r="24" />
        <circle cx="60" cy="60" r="34" />
      </g>
    </svg>
  );
};

export default BloomMark;
