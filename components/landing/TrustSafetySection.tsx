import React from 'react';
import { ShieldCheck, Video, Lock, MessageSquare } from 'lucide-react';
import { ViewType } from '../../types';

interface TrustSafetySectionProps {
    onNavigate: (view: ViewType) => void;
}

// Only what the product does (founder, 2026-10-12): the annual background
// check every caregiver completes before a family can book, the optional
// interview (a Google Meet link texted to both parties), Stripe payments, and
// text coordination. No "profile review" (there is no such step) and no
// Trust & Safety page behind it (removed). The provider is not named here.
const trustPoints = [
    { icon: <ShieldCheck className="w-6 h-6" strokeWidth={1.5} />, title: 'Annual background check by Checkr' },
    { icon: <Video className="w-6 h-6" strokeWidth={1.5} />, title: 'Interview before you book' },
    { icon: <Lock className="w-6 h-6" strokeWidth={1.5} />, title: 'Payments through Stripe' },
    { icon: <MessageSquare className="w-6 h-6" strokeWidth={1.5} />, title: 'Everything coordinated by text' },
];

export const TrustSafetySection: React.FC<TrustSafetySectionProps> = () => {
    return (
        <section className="bg-[#fafaf9] relative overflow-hidden pt-20 pb-32">
            <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
                <div className="flex flex-col lg:flex-row items-start justify-between gap-12 lg:gap-8">

                    {/* Left Column: Text & Features */}
                    <div className="w-full lg:w-2/3 pb-8 lg:pb-16 z-10 relative">
                        <p className="section-number mb-4">(1)</p>
                        <h2 className="font-display text-4xl md:text-[42px] font-semibold text-ink-900 leading-[1.1] mb-6 tracking-[-0.02em]">
                            Care you can look into before you book
                        </h2>
                        <p className="text-slate-600 text-[17px] mb-10 leading-relaxed max-w-md">
                            Every care provider completes a background check before families can book them.
                        </p>

                        <ul className="space-y-6">
                            {trustPoints.map((point, i) => (
                                <li key={i} className="flex items-center gap-5 group">
                                    <div className="text-slate-800 flex-shrink-0 group-hover:scale-110 transition-transform">
                                        {point.icon}
                                    </div>
                                    <h3 className="text-[17px] text-slate-700">{point.title}</h3>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {/* Middle Column: Image */}
                    <div className="w-full lg:w-1/3 flex justify-center z-0 relative">
                        <img
                            src="/assets/caregiver-senior-trust.png"
                            alt="Care provider and senior sitting together"
                            className="w-full max-w-[400px] lg:max-w-[450px] xl:max-w-[500px] h-auto mix-blend-multiply translate-y-4 lg:translate-y-24"
                        />
                    </div>

                </div>
            </div>

            {/* Curved bottom edge */}
            <div className="absolute bottom-0 left-0 w-full overflow-hidden leading-none z-20">
                <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="relative block w-full h-[40px] md:h-[80px]">
                    <path d="M321.39,56.44c58-10.79,114.16-30.13,172-41.86,82.39-16.72,168.19-17.73,250.45-.39C823.78,31,906.67,72,985.66,92.83c70.05,18.48,146.53,26.09,214.34,3V0H0V27.35A600.21,600.21,0,0,0,321.39,56.44Z" className="fill-white"></path>
                </svg>
            </div>
        </section>
    );
};
