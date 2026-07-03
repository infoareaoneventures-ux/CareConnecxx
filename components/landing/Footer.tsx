import React, { useState } from 'react';
import { Activity, Twitter, Facebook, Instagram } from 'lucide-react';
import { ViewType } from '../../types';
import { LegalDocs } from '../LegalDocs';

interface FooterProps {
    onNavigate: (view: ViewType) => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigate }) => {
    const [legalModal, setLegalModal] = useState<'privacy' | 'terms' | null>(null);

    return (
        <>
            <footer className="bg-paper-50 border-t hairline py-14">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                        <div className="col-span-2 md:col-span-2">
                            <div className="flex items-center space-x-2 mb-4">
                                <Activity className="text-ink-900 w-5 h-5" strokeWidth={2.5} />
                                <span className="font-display text-xl font-semibold text-ink-900">Evia</span>
                            </div>
                            <p className="text-ink-600 max-w-xs text-sm leading-relaxed">
                                Care for your loved one, coordinated entirely over text.
                            </p>
                            <div className="flex gap-4 mt-6">
                                <button aria-label="Twitter" className="w-8 h-8 bg-paper-100 rounded-full hover:bg-paper-200 text-ink-400 hover:text-ink-900 transition-colors cursor-pointer flex items-center justify-center">
                                    <Twitter className="w-4 h-4" />
                                </button>
                                <button aria-label="Facebook" className="w-8 h-8 bg-paper-100 rounded-full hover:bg-paper-200 text-ink-400 hover:text-ink-900 transition-colors cursor-pointer flex items-center justify-center">
                                    <Facebook className="w-4 h-4" />
                                </button>
                                <button aria-label="Instagram" className="w-8 h-8 bg-paper-100 rounded-full hover:bg-paper-200 text-ink-400 hover:text-ink-900 transition-colors cursor-pointer flex items-center justify-center">
                                    <Instagram className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        <div>
                            <h4 className="font-semibold text-ink-900 mb-4 text-sm">For Families</h4>
                            <ul className="space-y-2.5 text-ink-600 text-sm">
                                <li><button onClick={() => onNavigate('client-signup')} className="hover:text-ink-900 transition-colors">Find Care</button></li>
                                <li><button onClick={() => onNavigate('login')} className="hover:text-ink-900 transition-colors">Log In</button></li>
                                <li><button onClick={() => onNavigate('family-faq')} className="hover:text-ink-900 transition-colors">Family FAQ</button></li>
                                <li><button onClick={() => onNavigate('client-apply')} className="hover:text-ink-900 transition-colors">Create Account</button></li>
                            </ul>
                        </div>

                        <div>
                            <h4 className="font-semibold text-ink-900 mb-4 text-sm">For Caregivers</h4>
                            <ul className="space-y-2.5 text-ink-600 text-sm">
                                <li><button onClick={() => onNavigate('caregiver-signup')} className="hover:text-ink-900 transition-colors">Find Jobs</button></li>
                                <li><button onClick={() => onNavigate('trust')} className="hover:text-ink-900 transition-colors">Trust & Safety</button></li>
                                <li><button onClick={() => onNavigate('caregiver-apply')} className="hover:text-ink-900 transition-colors">Apply Online</button></li>
                                <li><button onClick={() => onNavigate('help-center')} className="hover:text-ink-900 transition-colors">Help Center</button></li>
                            </ul>
                        </div>
                    </div>
                    <div className="border-t hairline mt-12 pt-8 text-ink-400 text-sm flex flex-col md:flex-row justify-between items-center gap-4">
                        <span>&copy; 2026 · Designed in San Jose, California</span>
                        <div className="flex gap-6">
                            <button onClick={() => setLegalModal('privacy')} className="cursor-pointer hover:text-ink-900 transition-colors">Privacy</button>
                            <button onClick={() => setLegalModal('terms')} className="cursor-pointer hover:text-ink-900 transition-colors">Terms</button>
                            <button onClick={() => onNavigate('how-it-works')} className="cursor-pointer hover:text-ink-900 transition-colors">How It Works</button>
                            <button onClick={() => onNavigate('admin')} className="cursor-pointer hover:text-ink-900 transition-colors">Admin</button>
                        </div>
                    </div>
                </div>
            </footer>

            {legalModal && <LegalDocs type={legalModal} onClose={() => setLegalModal(null)} />}
        </>
    );
};
