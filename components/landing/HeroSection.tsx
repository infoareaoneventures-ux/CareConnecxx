import React, { useState } from 'react';
import { Search, ArrowRight } from 'lucide-react';
import { ViewType } from '../../types';

interface HeroSectionProps {
    onNavigate: (view: ViewType) => void;
}

const CONVERSATION: Array<{ from: 'cara' | 'user'; text: string }> = [
  { from: 'cara', text: "Maria just finished today's visit 💙" },
  { from: 'cara', text: "Your mom ate well and seemed happy. She mentioned her left knee was a little stiff — I'll keep an eye on it." },
  { from: 'user', text: "Should I be worried?" },
  { from: 'cara', text: "One stiff day isn't cause for concern. I'll flag it if it comes up again. Next visit is Wednesday at 9am." },
];

export const HeroSection: React.FC<HeroSectionProps> = ({ onNavigate }) => {
    const [zipCode, setZipCode] = useState('');

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        if (zipCode.trim()) sessionStorage.setItem('cara_signup_zip', zipCode.trim());
        onNavigate('client-signup');
    };

    return (
        <section className="relative overflow-hidden" style={{ backgroundColor: '#f0ece6' }}>
            <div className="bg-noise-overlay" aria-hidden="true"></div>

            {/* Subtle texture overlays */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[-80px] left-[-120px] w-[600px] h-[600px] rounded-full opacity-[0.07]"
                    style={{ background: 'radial-gradient(circle, #7c6f5a 0%, transparent 70%)' }} />
                {/* Blue brand accent — top-right, desktop only */}
                <div className="absolute hidden lg:block top-0 right-0 w-[700px] h-[700px] opacity-[0.06]"
                    style={{ background: 'radial-gradient(circle at 80% 20%, #3b82f6 0%, transparent 60%)' }} />
            </div>

            {/* ── Main hero — two-column on lg ── */}
            <div className="relative z-10 max-w-6xl mx-auto px-6 sm:px-8 pt-16 pb-0 flex flex-col lg:flex-row items-center gap-12 lg:gap-16">

                {/* ── Left column: copy ── */}
                <div className="flex-1 max-w-lg text-center lg:text-left pb-0 lg:pb-24">

                    {/* Badge */}
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/50 border border-black/[0.07] text-slate-500 text-xs font-medium mb-8 backdrop-blur-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                        iMessage · RCS · SMS · No app needed
                    </div>

                    {/* Headline */}
                    <h1 className="text-5xl sm:text-6xl lg:text-[64px] font-bold leading-[1.06] tracking-[-0.04em] text-black mb-5">
                        Care for your<br />
                        loved one.
                        <br />
                        <span className="text-slate-500">Evia handles</span>
                        <br className="hidden sm:block" />
                        <span className="text-slate-500"> the rest.</span>
                    </h1>

                    {/* Subline */}
                    <p className="text-lg text-slate-500 mb-10 leading-relaxed">
                        Care coordinated through texts.
                        No app. No login. Just text.
                    </p>

                    {/* CTA buttons */}
                    <div className="flex flex-col sm:flex-row items-center lg:items-start justify-center lg:justify-start gap-3 mb-10">
                        <button
                            onClick={() => { window.location.href = '/start?role=client'; }}
                            className="w-full sm:w-auto px-7 py-3.5 btn-depth-primary font-semibold rounded-2xl text-sm flex items-center justify-center gap-2"
                        >
                            Find a caregiver
                        </button>
                        <button
                            onClick={() => { window.location.href = '/start?role=caregiver'; }}
                            className="w-full sm:w-auto px-7 py-3.5 btn-depth-secondary font-semibold rounded-2xl text-sm flex items-center justify-center gap-2"
                        >
                            Apply as caregiver
                        </button>
                    </div>

                    {/* Trust pills */}
                    <div className="flex flex-wrap justify-center lg:justify-start gap-2.5 text-xs text-slate-500">
                        {[
                            'Background checked',
                            '$29.95/mo flat fee',
                            'Matched in 24–48 hrs',
                        ].map((item) => (
                            <span key={item} className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/50 border border-black/[0.06]">
                                <svg className="w-3 h-3 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                                {item}
                            </span>
                        ))}
                    </div>
                </div>

                {/* ── Right column: phone ── */}
                <div className="flex-shrink-0 flex justify-center relative">
                    {/* Removed blue glow for cleaner aesthetic */}

                    {/* Phone frame */}
                    <div
                        className="relative bg-white flex-shrink-0 overflow-hidden"
                        style={{
                            width: 340,
                            height: 700,
                            borderRadius: '3.25rem',
                            border: '10px solid #1a1a1a',
                            boxShadow: [
                                '0 0 0 1.5px #2d2d2d',
                                '0 50px 100px rgba(0,0,0,0.15)',
                                '0 12px 32px rgba(0,0,0,0.1)',
                            ].join(', '),
                        }}
                    >
                        {/* Dynamic island */}
                        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[90px] h-7 bg-black rounded-b-[1.4rem] z-20" />

                        {/* Status bar */}
                        <div className="flex items-center justify-between px-5 pt-9 pb-1">
                            <span className="text-black text-[11px] font-semibold">9:41</span>
                            <div className="flex items-center gap-1.5">
                                <svg className="w-3.5 h-3" viewBox="0 0 17 12" fill="none">
                                    <rect x="0" y="8" width="3" height="4" rx="0.5" fill="black"/>
                                    <rect x="4.5" y="5.5" width="3" height="6.5" rx="0.5" fill="black"/>
                                    <rect x="9" y="3" width="3" height="9" rx="0.5" fill="black"/>
                                    <rect x="13.5" y="0" width="3" height="12" rx="0.5" fill="black"/>
                                </svg>
                                <svg className="w-3.5 h-2.5" viewBox="0 0 16 12" fill="none">
                                    <path d="M1 4C4 1 12 1 15 4" stroke="black" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
                                    <path d="M3 7c2-2 8-2 10 0" stroke="black" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
                                    <path d="M5.5 10c1.5-1.5 3.5-1.5 5 0" stroke="black" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
                                    <circle cx="8" cy="12" r="1" fill="black"/>
                                </svg>
                                <svg className="w-5 h-3" viewBox="0 0 24 12" fill="none">
                                    <rect x="0.5" y="0.5" width="20" height="11" rx="2.5" stroke="black" strokeWidth="1"/>
                                    <rect x="2" y="2" width="15" height="8" rx="1.5" fill="black"/>
                                    <path d="M22 4v4a2 2 0 000-4z" fill="black"/>
                                </svg>
                            </div>
                        </div>

                        {/* iMessage nav bar */}
                        <div className="flex items-center justify-between px-4 py-1.5 border-b border-slate-100">
                            <button className="text-[#007aff] text-xs font-medium">‹ Messages</button>
                            <div className="flex flex-col items-center">
                                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-sm shadow-blue-300/40">
                                    <span className="text-white font-bold text-sm">C</span>
                                </div>
                                <p className="text-slate-900 text-[10px] font-semibold leading-tight mt-0.5">Evia 💙</p>
                            </div>
                            <button className="text-[#007aff]">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                </svg>
                            </button>
                        </div>

                        {/* Messages area */}
                        <div className="flex flex-col gap-2.5 px-3.5 pt-4 pb-3 bg-white overflow-hidden" style={{ height: 490 }}>
                            <p className="text-center text-slate-400 text-[10px] mb-1">Today 3:42 PM</p>

                            {CONVERSATION.map((msg, i) => (
                                <div key={i} className={`flex ${msg.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div
                                        className={`max-w-[80%] px-3.5 py-2.5 text-[12px] leading-relaxed ${
                                            msg.from === 'cara'
                                                ? 'text-slate-900 rounded-2xl rounded-tl-sm'
                                                : 'text-white rounded-2xl rounded-tr-sm'
                                        }`}
                                        style={{
                                            backgroundColor: msg.from === 'cara' ? '#e9e9eb' : '#007aff',
                                        }}
                                    >
                                        {msg.text}
                                    </div>
                                </div>
                            ))}

                            {/* Delivered */}
                            <p className="text-right text-[9px] text-slate-400 -mt-1 pr-1">Delivered</p>

                            {/* Typing indicator */}
                            <div className="flex justify-start mt-1">
                                <div className="px-3.5 py-3 rounded-2xl rounded-tl-sm flex items-center gap-1.5" style={{ backgroundColor: '#e9e9eb' }}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                                </div>
                            </div>
                        </div>

                        {/* Input bar */}
                        <div className="absolute bottom-0 left-0 right-0 px-3.5 pb-6 pt-2 bg-white border-t border-slate-100 flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full border border-slate-300 flex items-center justify-center flex-shrink-0">
                                <span className="text-slate-400 text-xs font-light">+</span>
                            </div>
                            <div className="flex-1 bg-white border border-slate-200 rounded-full px-4 py-1.5 text-slate-400 text-[11px]">
                                iMessage
                            </div>
                            <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#007aff' }}>
                                <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M2 21L23 12 2 3v7l15 2-15 2z"/>
                                </svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Trust strip ── */}
            <div style={{ backgroundColor: '#f0ece6' }} className="pt-10 pb-8 border-t border-black/[0.06]">
                <div className="max-w-3xl mx-auto px-4">
                    <div className="flex flex-wrap justify-center gap-6 text-sm text-slate-500">
                        {[
                            'Background checked caregivers',
                            '$29.95/mo — no agency markup',
                            'Matched in 24–48 hours',
                            'No app download required',
                        ].map((item) => (
                            <span key={item} className="flex items-center gap-1.5">
                                <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                                {item}
                            </span>
                        ))}
                    </div>
                </div>
            </div>

            {/* ── Cities bar ── */}
            <div className="py-5 border-t border-black/[0.06]" style={{ backgroundColor: '#ebe7e1' }}>
                <p className="text-center text-slate-400 text-xs">
                    Serving:{' '}
                    {['San Jose', 'Santa Clara', 'Sunnyvale', 'Mountain View', 'Palo Alto', 'Cupertino', 'Los Gatos', 'Campbell', 'Milpitas'].map((city, i, arr) => (
                        <span key={city}>
                            <span className="text-slate-500">{city}</span>
                            {i < arr.length - 1 && <span className="mx-1.5 text-slate-300">·</span>}
                        </span>
                    ))}
                </p>
            </div>

            {/* Hidden zip search */}
            <div className="hidden">
                <form onSubmit={handleSearch}>
                    <input value={zipCode} onChange={(e) => setZipCode(e.target.value)} />
                    <button type="submit"><ArrowRight /></button>
                    <Search />
                </form>
            </div>
        </section>
    );
};
