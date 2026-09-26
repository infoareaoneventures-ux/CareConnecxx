import React from 'react';
import { ViewType } from '../../types';

interface HeroSectionProps {
    onNavigate: (view: ViewType) => void;
}

export const HeroSection: React.FC<HeroSectionProps> = ({ onNavigate }) => {
    return (
        <section id="hero" className="relative overflow-hidden bg-paper-50">
            {/* Soft warm wash behind the phone — calm, no hard shapes */}
            <div className="absolute inset-x-0 bottom-0 h-[55%] pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(252,250,246,0) 0%, #F6F1E9 100%)' }} />

            <div className="relative z-10 max-w-4xl mx-auto px-6 pt-16 sm:pt-20 pb-0 flex flex-col items-center text-center">

                {/* Badge */}
                <button
                    onClick={() => onNavigate('how-it-works')}
                    className="inline-flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-full bg-white border hairline text-ink-600 text-[13px] font-medium mb-8 shadow-sm hover:shadow transition-shadow"
                >
                    <span className="px-2 py-0.5 rounded-full bg-paper-100 border hairline text-ink-900 text-[11px] font-semibold">New</span>
                    Care coordinated over iMessage
                    <span aria-hidden="true" className="text-ink-400">›</span>
                </button>

                {/* Headline — display serif, calm and human */}
                <h1 className="font-display text-[44px] sm:text-6xl lg:text-[68px] font-semibold leading-[1.02] tracking-[-0.03em] text-ink-900 mb-6">
                    Care for your loved one.
                    <br />
                    <span className="text-ink-400">Evia handles the rest.</span>
                </h1>

                {/* Subline */}
                <p className="text-lg text-ink-600 mb-9 leading-relaxed max-w-md">
                    Trusted caregivers, coordinated entirely over text.
                    No app. No login. Just a conversation.
                </p>

                {/* One CTA + one quiet link */}
                <div className="flex flex-col sm:flex-row items-center gap-5 mb-7">
                    <button
                        onClick={() => { window.location.href = '/start?role=client'; }}
                        className="w-full sm:w-auto px-8 py-4 btn-depth-primary font-semibold rounded-full text-[15px]"
                    >
                        Find a caregiver
                    </button>
                    <button
                        onClick={() => { window.location.href = '/start?role=caregiver'; }}
                        className="text-ink-600 hover:text-ink-900 text-[15px] font-medium transition-colors"
                    >
                        Apply as a caregiver →
                    </button>
                </div>

                {/* Single quiet trust line */}
                <p className="text-[13px] text-ink-400 mb-14">
                    Background-checked caregivers · $29.95/mo flat · Matched in 24–48 hours
                </p>

                {/* Launch film — the product demo, muted seamless loop */}
                <div className="relative flex justify-center w-full pb-16">
                    <video
                        src="/assets/evia-launch-hero.mp4"
                        poster="/assets/evia-launch-hero-poster.webp"
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        aria-label="Demo: a family coordinating Mom's care with Evia over text"
                        className="w-full max-w-3xl rounded-3xl border hairline"
                        style={{ boxShadow: '0 40px 90px rgba(26,31,43,0.12)' }}
                    />
                </div>
            </div>

            {/* ── Cities hairline caption ── */}
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
