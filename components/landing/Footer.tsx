import React from 'react';
import { Link } from 'react-router-dom';
import { BloomMark } from '../ui/BloomMark';
import { supportPhone } from '../../utils/launchConfig';

// Minimal footer (founder, 2026-10-12): the mark, one line, the help phone,
// five links. Router links only, so every pre-login page (landing, login,
// /start, recovery, Privacy, Terms, not-found) mounts the same footer. The
// social icons and the For Families / For Caregivers columns are gone with the
// pages they pointed at; Privacy and Terms open the real /privacy and /terms
// pages (the old LegalDocs modal duplicated them and named the provider).
// The help phone moved here from the task pages' top bar (founder, 2026-10-12).
export const Footer: React.FC = () => {
    const linkClass = 'cursor-pointer hover:text-ink-900 transition-colors';
    return (
        <footer className="bg-paper-50 border-t hairline py-14">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex items-center space-x-2 mb-4">
                    <BloomMark className="text-ink-900 w-5 h-5" />
                    <span className="font-display text-xl font-semibold text-ink-900">Evia</span>
                </div>
                <p className="text-ink-600 max-w-xs text-sm leading-relaxed">
                    Care for your loved one, coordinated entirely over text.
                </p>
                {supportPhone && (
                    <p className="text-ink-600 text-sm leading-relaxed mt-3">
                        Need help?{' '}
                        <a href={supportPhone.telHref} className="font-medium text-ink-900 hover:underline">
                            Call {supportPhone.display}
                        </a>
                    </p>
                )}

                <div className="border-t hairline mt-12 pt-8 text-ink-400 text-sm flex flex-col md:flex-row justify-between items-center gap-4">
                    <span>&copy; 2026 Evia · San Jose, California</span>
                    <nav aria-label="Footer" className="flex flex-wrap justify-center gap-6">
                        <Link to="/privacy" className={linkClass}>Privacy</Link>
                        <Link to="/terms" className={linkClass}>Terms</Link>
                        <Link to="/login" className={linkClass}>Log in</Link>
                        <Link to="/start?role=client" className={linkClass}>Get started</Link>
                        <Link to="/admin" className={linkClass}>Admin</Link>
                    </nav>
                </div>
            </div>
        </footer>
    );
};
