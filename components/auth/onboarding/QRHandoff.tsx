import React, { useState } from 'react';
import { QRCanvas } from './QRCanvas';
import { buildSmsHref, formatPhoneForDisplay, SMS_BODY } from './smsLink';

interface Props {
  linqPhone: string;
  tone: 'dark' | 'light';
  /** Caption explaining the QR — different copy for caregiver vs family modes. */
  caption: React.ReactNode;
  /** Optional small helper line under the phone number. */
  helper?: React.ReactNode;
}

export const QRHandoff: React.FC<Props> = ({ linqPhone, tone, caption, helper }) => {
  const [copied, setCopied] = useState(false);
  const href = buildSmsHref(linqPhone);
  const isDark = tone === 'dark';

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(linqPhone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard refused — surface nothing, user can still read the number */
    }
  };

  return (
    <div className="w-full space-y-5">
      <div className={isDark ? 'text-ink-600 text-sm text-center' : 'text-ink-600 text-base text-center leading-relaxed'}>
        {caption}
      </div>

      <div className={
        isDark
          ? 'mx-auto rounded-3xl bg-white p-5 w-fit shadow-lg border hairline'
          : 'mx-auto rounded-3xl bg-white p-5 w-fit shadow-lg border hairline'
      }>
        <a href={href} aria-label={`Open Messages to text Evia: ${SMS_BODY}`} className="block">
          <QRCanvas data={href} size={260} />
        </a>
      </div>

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
