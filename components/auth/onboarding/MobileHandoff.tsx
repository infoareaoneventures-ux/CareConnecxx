import React, { useEffect, useRef, useState } from 'react';
import { buildSmsHref, formatPhoneForDisplay } from './smsLink';

interface Props {
  linqPhone: string;
  tone: 'dark' | 'light';
  /** Body copy above the button. */
  caption: React.ReactNode;
  /** Big button label — e.g. "Send to Evia" (family) or "Open Messages" (caregiver). */
  ctaLabel: string;
  /** Optional sub-hint beneath the button. */
  helper?: React.ReactNode;
}

export const MobileHandoff: React.FC<Props> = ({ linqPhone, tone, caption, ctaLabel, helper }) => {
  const [copied, setCopied] = useState(false);
  const triggered = useRef(false);
  const href = buildSmsHref(linqPhone);
  const isDark = tone === 'dark';

  // Auto-trigger the sms: deep link once on mount. iOS Safari shows the
  // "Open this page in Messages?" sheet; Android Chrome opens the SMS app
  // directly. If the prompt is dismissed, the button below is the manual
  // recovery path — we never re-trigger the link automatically because that
  // would feel pushy.
  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;
    const t = setTimeout(() => {
      try { window.location.href = href; } catch { /* ignored */ }
    }, 300);
    return () => clearTimeout(t);
  }, [href]);

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(linqPhone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard refused */ }
  };

  return (
    <div className="w-full space-y-6">
      <div className={isDark ? 'text-white/70 text-base text-center leading-relaxed' : 'text-slate-700 text-lg text-center leading-relaxed'}>
        {caption}
      </div>

      <a
        href={href}
        className={
          isDark
            ? 'block w-full text-center rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 transition py-5 text-white font-semibold text-lg shadow-lg shadow-blue-500/20'
            : 'block w-full text-center rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 transition py-5 text-white font-semibold text-lg shadow-lg shadow-emerald-200'
        }
      >
        {ctaLabel}
      </a>

      <div className="text-center space-y-1.5">
        <button
          type="button"
          onClick={copyNumber}
          className={
            isDark
              ? 'inline-flex items-center gap-2 rounded-full bg-white/5 hover:bg-white/10 transition px-4 py-2 text-sm font-medium text-white'
              : 'inline-flex items-center gap-2 rounded-full bg-slate-100 hover:bg-slate-200 transition px-5 py-2.5 text-base font-medium text-slate-900'
          }
        >
          <span>{formatPhoneForDisplay(linqPhone)}</span>
          <span className={isDark ? 'text-white/40 text-xs' : 'text-slate-500 text-xs'}>
            {copied ? 'copied' : 'tap to copy'}
          </span>
        </button>
        {helper && (
          <div className={isDark ? 'text-white/30 text-xs' : 'text-slate-500 text-sm'}>
            {helper}
          </div>
        )}
      </div>
    </div>
  );
};
