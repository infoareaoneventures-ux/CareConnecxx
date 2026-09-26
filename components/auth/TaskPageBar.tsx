import React from 'react';
import { Link } from 'react-router-dom';
import { BloomMark } from '../ui/BloomMark';
import { supportPhone } from '../../utils/launchConfig';

// The one top bar every pre-login TASK page shares (founder, 2026-09-25):
// /start (both roles), /login, and the account-recovery page. Logo takes you
// home, the help line is one tap away, and nothing else — these pages have a
// single job, so no menu to wander off into. Marketing/help pages keep the full
// site header instead.
export const TaskPageBar: React.FC = () => (
  <header className="px-6 pt-8 pb-2 flex items-center justify-between max-w-2xl w-full mx-auto">
    <Link to="/" className="flex items-center gap-2 group" aria-label="Evia home">
      <div className="w-9 h-9 rounded-xl bg-paper-100 border hairline flex items-center justify-center">
        <BloomMark className="w-5 h-5 text-ink-900" />
      </div>
      <span className="font-semibold text-ink-900 group-hover:text-ink-600 transition">Evia</span>
    </Link>
    {supportPhone && (
      <a href={supportPhone.telHref} className="text-sm font-medium text-ink-600 hover:text-ink-900 transition">
        Need help? Call {supportPhone.display}
      </a>
    )}
  </header>
);
