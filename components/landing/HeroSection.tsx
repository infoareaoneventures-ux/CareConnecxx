import React from 'react';
import { ViewType } from '../../types';
import { CLIENT_MONTHLY_PRICE, CAREGIVER_ANNUAL_PRICE, fmtMoney } from '../../utils/pricing';

interface HeroSectionProps {
    onNavigate: (view: ViewType) => void;
}

// The landing page's first section (founder, 2026-10-12: ONE public page —
// hero, "look into before you book", the eight services, footer). No claims:
// the sub-line says what the product is, the small line states the two
// memberships from utils/pricing.ts (never a hand-typed amount), and both
// doors go to /start.
export const HeroSection: React.FC<HeroSectionProps> = ({ onNavigate }) => {
    return (
        <section id="hero" className="relative overflow-hidden bg-paper-50">
            {/* Soft warm wash behind the phone — calm, no hard shapes */}
            <div className="absolute inset-x-0 bottom-0 h-[55%] pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(252,250,246,0) 0%, #F6F1E9 100%)' }} />

            <div className="relative z-10 max-w-4xl mx-auto px-6 pt-16 sm:pt-20 pb-0 flex flex-col items-center text-center">

                {/* Pill — plain text, no page behind it any more */}
                <span className="inline-flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-full bg-white border hairline text-ink-600 text-[13px] font-medium mb-8 shadow-sm">
                    <span className="px-2 py-0.5 rounded-full bg-paper-100 border hairline text-ink-900 text-[11px] font-semibold">New</span>
                    Care coordinated by text message
                </span>

                {/* Headline — display serif, calm and human */}
                <h1 className="font-display text-[44px] sm:text-6xl lg:text-[68px] font-semibold leading-[1.02] tracking-[-0.03em] text-ink-900 mb-6">
                    Care for your loved one.
                    <br />
                    <span className="text-ink-400">Evia handles the rest.</span>
                </h1>

                {/* Subline */}
                <p className="text-lg text-ink-600 mb-9 leading-relaxed max-w-md">
                    Local care providers, coordinated entirely over text.
                    No app. No login. Just a conversation.
                </p>

                {/* One CTA + one quiet link — the family door and the caregiver door */}
                <div className="flex flex-col sm:flex-row items-center gap-5 mb-7">
                    <button
                        onClick={() => onNavigate('client-apply')}
                        className="w-full sm:w-auto px-8 py-4 btn-depth-primary font-semibold rounded-full text-[15px]"
                    >
                        Find a care provider
                    </button>
                    <button
                        onClick={() => onNavigate('caregiver-apply')}
                        className="text-ink-600 hover:text-ink-900 text-[15px] font-medium transition-colors"
                    >
                        Apply as a care provider →
                    </button>
                </div>

                {/* Single factual line — one fact per role, figures from utils/pricing.ts */}
                <p className="text-[13px] text-ink-400 mb-16">
                    Families: {fmtMoney(CLIENT_MONTHLY_PRICE)}/month, cancel anytime · Care Providers: background check required, {fmtMoney(CAREGIVER_ANNUAL_PRICE)}/year
                </p>
                {/* The launch demo film was removed 2026-10-12 (founder): it played an
                    invented conversation and its baked-in caption said "trusted caregivers". */}
            </div>

            {/* ── Service-area caption (plain text; the city pages are gone) ── */}
            <div className="relative z-10 py-4 border-t hairline bg-paper-100">
                <p className="text-center text-ink-400 text-xs">
                    Serving Santa Clara County —{' '}
                    {['San Jose', 'Santa Clara', 'Sunnyvale', 'Mountain View', 'Palo Alto', 'Cupertino', 'Los Gatos', 'Campbell', 'Milpitas'].map((city, i, arr) => (
                        <span key={city}>
                            <span className="text-ink-600">{city}</span>
                            {i < arr.length - 1 && <span className="mx-1.5 text-ink-400">·</span>}
                        </span>
                    ))}
                </p>
            </div>
        </section>
    );
};
