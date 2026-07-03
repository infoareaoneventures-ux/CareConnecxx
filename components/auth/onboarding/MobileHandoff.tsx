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
      <div className={isDark ? 'text-ink-600 text-base text-center leading-relaxed' : 'text-ink-600 text-lg text-center leading-relaxed'}>
        {caption}
      </div>

      <a
        href={href}
        className={
          isDark
            ? 'block w-full text-center btn-depth-primary rounded-full py-5 font-semibold text-lg'
            : 'block w-full text-center btn-depth-primary rounded-full py-5 font-semibold text-lg'
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
              ? 'inline-flex items-center gap-2 rounded-full bg-paper-100 border hairline hover:shadow-sm transition px-4 py-2.5 text-sm font-medium text-ink-900'
              : 'inline-flex items-center gap-2 rounded-full bg-paper-100 border hairline hover:shadow-sm transition px-5 py-2.5 text-base font-medium text-ink-900'
          }
        >
          <span>{formatPhoneForDisplay(linqPhone)}</span>
          <span className={isDark ? 'text-ink-400 text-xs' : 'text-ink-400 text-xs'}>
            {copied ? 'copied' : 'tap to copy'}
          </span>
        </button>
        {helper && (
          <div className={isDark ? 'text-ink-400 text-xs' : 'text-ink-600 text-sm'}>
            {helper}
          </div>
        )}
      </div>
    </div>
  );
};
