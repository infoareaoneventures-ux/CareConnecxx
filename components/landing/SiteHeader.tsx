import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { BloomMark } from '../ui/BloomMark';
import { Button } from '../ui/Button';

// The ONE public header (founder, 2026-10-12): the mark + "Evia" (home),
// Log in, Get started — on the landing page AND every other pre-login page
// (login, /start, account recovery, Privacy, Terms, not-found). Router links
// only, so any page can mount it without the landing page's onNavigate.
export const SiteHeader: React.FC = () => {
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const go = (to: string) => { setOpen(false); navigate(to); };
    return (
        <header className="sticky top-0 z-50 bg-paper-50/90 backdrop-blur-md border-b hairline transition-all duration-300">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex justify-between items-center h-16">
                    <Link to="/" className="flex items-center space-x-2" aria-label="Evia home">
                        <BloomMark className="text-ink-900 w-5 h-5" />
                        <span className="font-display text-[22px] font-semibold text-ink-900 tracking-tight">Evia</span>
                    </Link>

                    <div className="hidden md:flex items-center space-x-6">
                        <Link to="/login" className="text-ink-600 hover:text-ink-900 text-[15px] font-medium transition-colors">
                            Log in
                        </Link>
                        <Link to="/start?role=client" className="btn-depth-primary font-semibold px-5 py-2.5 rounded-full text-sm">
                            Get started
                        </Link>
                    </div>

                    <div className="md:hidden">
                        <button
                            onClick={() => setOpen(!open)}
                            className="text-slate-600 p-2"
                            aria-label={open ? 'Close menu' : 'Open menu'}
                            aria-expanded={open}
                        >
                            {open ? <X size={24} /> : <Menu size={24} />}
                        </button>
                    </div>
                </div>
            </div>

            {open && (
                <div className="md:hidden bg-white border-t border-slate-100 absolute w-full shadow-xl animate-slide-in">
                    <div className="px-4 pt-2 pb-6 space-y-2">
                        <button onClick={() => go('/login')} className="block w-full text-left px-3 py-3 text-base font-medium text-primary-600 hover:bg-primary-50 rounded-lg">Log in</button>
                        <Button fullWidth onClick={() => go('/start?role=client')} variant="primary">
                            Get started
                        </Button>
                    </div>
                </div>
            )}
        </header>
    );
};
