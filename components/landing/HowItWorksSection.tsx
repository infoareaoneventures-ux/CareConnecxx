import React, { useState } from 'react';
import { UserPlus, Search, CreditCard, ShieldCheck, ArrowRight, Check, Play } from 'lucide-react';
import { ViewType } from '../../types';

interface HowItWorksSectionProps {
    onNavigate: (view: ViewType) => void;
}

const FAMILY_STEPS = [
    {
        number: '01',
        icon: UserPlus,
        color: 'teal',
        title: 'Create your free profile',
        subtitle: 'Free — takes 3 minutes',
        bullets: [
            "Tell us about your senior (age, health conditions)",
            "Set your schedule and care needs",
            "We build a personalized care profile instantly",
        ],
        highlight: null,
    },
    {
        number: '02',
        icon: Search,
        color: 'blue',
        title: 'Get personalized caregiver matches',
        subtitle: 'Free to browse, no card required',
        bullets: [
            "Personalized matches tailored to your senior's exact conditions",
            "Filter by certification, distance, and availability",
            "Post a job — let caregivers apply to you",
        ],
        highlight: null,
    },
    {
        number: '03',
        icon: CreditCard,
        color: 'blue',
        title: 'Get a membership to book',
        subtitle: 'Only $29.95/mo — 30% less than competitors',
        bullets: [
            "Unlock direct messaging with caregivers",
            "Book visits and video interviews",
            "24/7 AI coordinator + live human support",
        ],
        highlight: '7-day love-it guarantee or free rematch',
    },
    {
        number: '04',
        icon: ShieldCheck,
        color: 'orange',
        title: 'Book & pay securely',
        subtitle: 'Powered by Stripe · GPS-verified visits',
        bullets: [
            "GPS clock-in / clock-out on every visit",
            "Daily care journal updates sent to your phone",
            "Automatic payments — no cash, no hassle",
        ],
        highlight: 'Caregivers keep 100% of what you pay them',
    },
];

const COLOR_MAP: Record<string, { bg: string; border: string; text: string; light: string; num: string }> = {
    teal:   { bg: 'bg-primary-600',   border: 'border-primary-200',  text: 'text-primary-600',   light: 'bg-primary-50',   num: 'bg-primary-600' },
    blue:   { bg: 'bg-blue-600',   border: 'border-blue-200',  text: 'text-blue-600',   light: 'bg-blue-50',   num: 'bg-blue-600' },
    orange: { bg: 'bg-accent-500', border: 'border-accent-200',text: 'text-accent-600', light: 'bg-accent-50', num: 'bg-accent-500' },
};

export const HowItWorksSection: React.FC<HowItWorksSectionProps> = ({ onNavigate }) => {
    const [activeTab, setActiveTab] = useState<'family' | 'caregiver'>('family');

    return (
        <section id="how-it-works" className="py-24 bg-slate-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

                {/* Header */}
                <div className="text-center max-w-3xl mx-auto mb-12">
                    <div className="inline-flex items-center px-3 py-1 rounded-full bg-primary-50 text-primary-700 text-sm font-semibold mb-4 border border-primary-100">
                        Simple Process
                    </div>
                    <h2 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4 tracking-tight">
                        How CareConnex works
                    </h2>
                    <p className="text-xl text-slate-500">
                        From sign-up to first visit — usually in 24–48 hours.
                    </p>
                </div>

                {/* Tab Toggle */}
                <div className="flex justify-center mb-14">
                    <div className="inline-flex bg-white border border-slate-200 rounded-xl p-1 shadow-sm">
                        <button
                            onClick={() => setActiveTab('family')}
                            className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                                activeTab === 'family'
                                    ? 'bg-primary-600 text-white shadow-sm'
                                    : 'text-slate-500 hover:text-slate-700'
                            }`}
                        >
                            For Families
                        </button>
                        <button
                            onClick={() => setActiveTab('caregiver')}
                            className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                                activeTab === 'caregiver'
                                    ? 'bg-primary-600 text-white shadow-sm'
                                    : 'text-slate-500 hover:text-slate-700'
                            }`}
                        >
                            For Caregivers
                        </button>
                    </div>
                </div>

                {/* Family Flow */}
                {activeTab === 'family' && (
                    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
                        {FAMILY_STEPS.map((step, i) => {
                            const c = COLOR_MAP[step.color];
                            const Icon = step.icon;
                            return (
                                <div key={i} className="relative">
                                    {/* Connector line */}
                                    {i < FAMILY_STEPS.length - 1 && (
                                        <div className="hidden lg:block absolute top-10 left-[calc(100%-12px)] w-6 h-0.5 bg-slate-200 z-10" />
                                    )}

                                    <div className={`bg-white rounded-2xl border ${c.border} p-6 h-full flex flex-col shadow-sm hover:shadow-md transition-shadow`}>
                                        {/* Number + Icon */}
                                        <div className="flex items-center gap-3 mb-5">
                                            <div className={`w-10 h-10 ${c.num} rounded-xl flex items-center justify-center flex-shrink-0`}>
                                                <Icon className="w-5 h-5 text-white" />
                                            </div>
                                            <span className={`text-3xl font-black ${c.text} opacity-20`}>{step.number}</span>
                                        </div>

                                        {/* Title */}
                                        <h3 className="text-lg font-bold text-slate-900 mb-1 leading-snug">{step.title}</h3>
                                        <p className={`text-xs font-semibold ${c.text} mb-4`}>{step.subtitle}</p>

                                        {/* Bullets */}
                                        <ul className="space-y-2 flex-1">
                                            {step.bullets.map((b, j) => (
                                                <li key={j} className="flex items-start gap-2 text-sm text-slate-600">
                                                    <Check className={`w-4 h-4 ${c.text} flex-shrink-0 mt-0.5`} />
                                                    {b}
                                                </li>
                                            ))}
                                        </ul>

                                        {/* Highlight badge */}
                                        {step.highlight && (
                                            <div className={`mt-4 px-3 py-2 ${c.light} rounded-lg border ${c.border}`}>
                                                <p className={`text-xs font-semibold ${c.text}`}>✓ {step.highlight}</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Caregiver Flow */}
                {activeTab === 'caregiver' && (
                    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
                        {[
                            {
                                number: '01', icon: UserPlus, color: 'teal',
                                title: 'Create your free profile',
                                subtitle: 'Free to join — always',
                                bullets: ['10-minute profile setup', 'Upload certifications & video intro', 'Set your availability and rates'],
                                highlight: null,
                            },
                            {
                                number: '02', icon: Search, color: 'blue',
                                title: 'Get matched to families',
                                subtitle: 'AI matches you to the right clients',
                                bullets: ['Families in your area see your profile', 'Browse open job postings', 'Receive job applications directly'],
                                highlight: null,
                            },
                            {
                                number: '03', icon: Play, color: 'blue',
                                title: 'Interview & get hired',
                                subtitle: 'Video or phone — you choose',
                                bullets: ['Video interviews through the platform', 'Chat directly with families', 'Accept or decline jobs on your schedule'],
                                highlight: null,
                            },
                            {
                                number: '04', icon: CreditCard, color: 'orange',
                                title: 'Get paid fast',
                                subtitle: 'Keep 100% of your earnings',
                                bullets: ['GPS clock-in confirms your hours', 'Instant or next-day bank transfer', 'No commission — zero platform cut'],
                                highlight: 'Zero commission on earnings',
                            },
                        ].map((step, i) => {
                            const c = COLOR_MAP[step.color];
                            const Icon = step.icon;
                            return (
                                <div key={i} className="relative">
                                    {i < 3 && (
                                        <div className="hidden lg:block absolute top-10 left-[calc(100%-12px)] w-6 h-0.5 bg-slate-200 z-10" />
                                    )}
                                    <div className={`bg-white rounded-2xl border ${c.border} p-6 h-full flex flex-col shadow-sm hover:shadow-md transition-shadow`}>
                                        <div className="flex items-center gap-3 mb-5">
                                            <div className={`w-10 h-10 ${c.num} rounded-xl flex items-center justify-center flex-shrink-0`}>
                                                <Icon className="w-5 h-5 text-white" />
                                            </div>
                                            <span className={`text-3xl font-black ${c.text} opacity-20`}>{step.number}</span>
                                        </div>
                                        <h3 className="text-lg font-bold text-slate-900 mb-1 leading-snug">{step.title}</h3>
                                        <p className={`text-xs font-semibold ${c.text} mb-4`}>{step.subtitle}</p>
                                        <ul className="space-y-2 flex-1">
                                            {step.bullets.map((b, j) => (
                                                <li key={j} className="flex items-start gap-2 text-sm text-slate-600">
                                                    <Check className={`w-4 h-4 ${c.text} flex-shrink-0 mt-0.5`} />
                                                    {b}
                                                </li>
                                            ))}
                                        </ul>
                                        {step.highlight && (
                                            <div className={`mt-4 px-3 py-2 ${c.light} rounded-lg border ${c.border}`}>
                                                <p className={`text-xs font-semibold ${c.text}`}>✓ {step.highlight}</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* CTA Row */}
                <div className="mt-14 flex flex-col sm:flex-row items-center justify-center gap-4">
                    <button
                        onClick={() => onNavigate('client-signup')}
                        className="inline-flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white font-semibold px-8 py-4 rounded-xl text-base shadow-md shadow-primary-100 transition-colors"
                    >
                        Find Care Now — Free
                        <ArrowRight className="w-5 h-5" />
                    </button>
                    <button
                        onClick={() => onNavigate('caregiver-signup')}
                        className="inline-flex items-center gap-2 border-2 border-slate-200 text-slate-700 hover:border-primary-300 hover:text-primary-700 font-semibold px-8 py-4 rounded-xl text-base transition-colors"
                    >
                        Apply as a Caregiver
                    </button>
                </div>

            </div>
        </section>
    );
};
