import React from 'react';
import { Check, X, ArrowRight, Star } from 'lucide-react';
import { ViewType } from '../../types';

interface PricingComparisonSectionProps {
    onNavigate: (view: ViewType) => void;
}

const FEATURES = [
    { label: 'Senior-specific matching (dementia, Parkinson\'s, etc.)', careconnex: true,  competitor: false, agency: true  },
    { label: 'Browse caregivers free',                                  careconnex: true,  competitor: true,  agency: false },
    { label: 'AI match score + plain-English reasons',                  careconnex: true,  competitor: false, agency: false },
    { label: 'Background check included in membership',                 careconnex: true,  competitor: false, agency: true  },
    { label: 'GPS clock-in / clock-out',                                careconnex: true,  competitor: false, agency: false },
    { label: 'Daily care journal sent to family',                       careconnex: true,  competitor: false, agency: false },
    { label: 'Video interview before hiring',                           careconnex: true,  competitor: false, agency: true  },
    { label: 'Direct messaging with caregiver',                         careconnex: true,  competitor: true,  agency: false },
    { label: 'Instant same-day caregiver payouts',                      careconnex: true,  competitor: false, agency: false },
    { label: 'Zero per-booking commission',                             careconnex: true,  competitor: false, agency: false },
];

export const PricingComparisonSection: React.FC<PricingComparisonSectionProps> = ({ onNavigate }) => {
    return (
        <section className="py-24 bg-slate-50">
            <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">

                {/* Header */}
                <div className="text-center max-w-2xl mx-auto mb-14">
                    <div className="inline-flex items-center px-3 py-1 rounded-full bg-accent-50 text-accent-700 text-sm font-semibold mb-4 border border-accent-100">
                        Pricing
                    </div>
                    <h2 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4 tracking-tight">
                        Why families choose CareConnex
                    </h2>
                    <p className="text-xl text-slate-500">
                        More features, lower cost — purpose-built for senior care.
                    </p>
                </div>

                {/* Price cards row */}
                <div className="grid md:grid-cols-3 gap-4 mb-10">
                    {/* Traditional Agency */}
                    <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center shadow-sm">
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Traditional Agency</p>
                        <div className="mb-1">
                            <span className="text-3xl font-black text-slate-400">$3,000+</span>
                            <span className="text-sm text-slate-400">/mo</span>
                        </div>
                        <p className="text-xs text-slate-400 mb-4">High markup, no transparency</p>
                        <div className="h-1 w-16 mx-auto rounded-full bg-slate-200" />
                    </div>

                    {/* Care.com */}
                    <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center shadow-sm">
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Care.com</p>
                        <div className="mb-1">
                            <span className="text-3xl font-black text-slate-500">$35</span>
                            <span className="text-sm text-slate-400">/mo</span>
                        </div>
                        <p className="text-xs text-slate-400 mb-4">+$300 background check add-on · 2.9★ app</p>
                        <div className="h-1 w-16 mx-auto rounded-full bg-slate-300" />
                    </div>

                    {/* CareConnex — highlighted */}
                    <div className="bg-primary-600 rounded-2xl border border-primary-500 p-6 text-center shadow-lg shadow-primary-100 relative">
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                            <span className="bg-accent-500 text-white text-xs font-bold px-3 py-1 rounded-full shadow-sm whitespace-nowrap">
                                30% cheaper · Senior-specific
                            </span>
                        </div>
                        <p className="text-xs font-semibold text-primary-200 uppercase tracking-widest mb-3">CareConnex</p>
                        <div className="mb-1">
                            <span className="text-4xl font-black text-white">$29.95</span>
                            <span className="text-sm text-primary-200">/mo</span>
                        </div>
                        <p className="text-xs text-primary-200 mb-4">Cancel anytime · 7-day guarantee</p>
                        <div className="flex items-center justify-center gap-1 mb-1">
                            {[...Array(5)].map((_, i) => (
                                <Star key={i} className="w-3.5 h-3.5 text-accent-400 fill-accent-400" />
                            ))}
                        </div>
                        <p className="text-xs text-primary-200">4.9 / 5 from 500+ families</p>
                    </div>
                </div>

                {/* Feature comparison table */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    {/* Table header */}
                    <div className="grid grid-cols-4 bg-slate-50 border-b border-slate-200 px-6 py-3">
                        <div className="col-span-1" />
                        <div className="text-center text-xs font-semibold text-slate-400 uppercase tracking-wide">Agency</div>
                        <div className="text-center text-xs font-semibold text-slate-400 uppercase tracking-wide">Care.com</div>
                        <div className="text-center text-xs font-bold text-primary-700 uppercase tracking-wide">CareConnex</div>
                    </div>

                    {FEATURES.map((f, i) => (
                        <div
                            key={i}
                            className={`grid grid-cols-4 px-6 py-3 items-center ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} border-b border-slate-100 last:border-0`}
                        >
                            <p className="col-span-1 text-sm text-slate-700 pr-4">{f.label}</p>
                            <div className="flex justify-center">
                                {f.agency
                                    ? <Check className="w-4 h-4 text-slate-400" />
                                    : <X className="w-4 h-4 text-slate-200" />
                                }
                            </div>
                            <div className="flex justify-center">
                                {f.competitor
                                    ? <Check className="w-4 h-4 text-slate-400" />
                                    : <X className="w-4 h-4 text-slate-200" />
                                }
                            </div>
                            <div className="flex justify-center">
                                {f.careconnex
                                    ? <Check className="w-5 h-5 text-primary-600" strokeWidth={2.5} />
                                    : <X className="w-4 h-4 text-slate-200" />
                                }
                            </div>
                        </div>
                    ))}
                </div>

                {/* CTA */}
                <div className="text-center mt-10">
                    <button
                        onClick={() => onNavigate('client-signup')}
                        className="inline-flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white font-semibold px-8 py-4 rounded-xl text-base shadow-md shadow-primary-100 transition-colors"
                    >
                        Get Started Free
                        <ArrowRight className="w-5 h-5" />
                    </button>
                    <p className="text-sm text-slate-400 mt-3">No credit card required to browse · $29.95/mo to book</p>
                </div>

            </div>
        </section>
    );
};