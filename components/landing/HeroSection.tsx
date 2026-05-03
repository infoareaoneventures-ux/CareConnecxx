import React, { useState } from 'react';
import {
  ShieldCheck, CheckCircle, Clock, DollarSign, TrendingUp, ArrowRight, MapPin, Search, Tag
} from 'lucide-react';
import { ViewType } from '../../types';

interface HeroSectionProps {
    onNavigate: (view: ViewType) => void;
}

export const HeroSection: React.FC<HeroSectionProps> = ({ onNavigate }) => {
    const [zipCode, setZipCode] = useState('');

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        onNavigate('client-signup');
    };

    return (
        <section className="relative overflow-hidden bg-gradient-to-br from-primary-50 via-white to-accent-50">
            {/* Subtle background decoration */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-[-10%] left-[-5%] w-[500px] h-[500px] bg-primary-100/40 rounded-full blur-3xl"></div>
                <div className="absolute bottom-[-10%] right-[-5%] w-[400px] h-[400px] bg-accent-100/30 rounded-full blur-3xl"></div>
            </div>

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
                <div className="min-h-[88vh] flex flex-col lg:flex-row items-center gap-12 lg:gap-16 py-16 lg:py-20">

                    {/* Left Content */}
                    <div className="flex-1 space-y-8 text-center lg:text-left">

                        {/* Location badge */}
                        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-50 border border-primary-100 text-primary-700">
                            <MapPin className="w-4 h-4" />
                            <span className="text-sm font-medium">Now Serving Santa Clara County</span>
                        </div>

                        {/* Headline */}
                        <div className="space-y-4">
                            <h1 className="text-5xl md:text-6xl lg:text-7xl font-extrabold leading-[1.1] text-slate-900 tracking-tight">
                                Peace of mind for{' '}
                                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-primary-500">
                                    your family
                                </span>
                            </h1>
                            <p className="text-xl md:text-2xl text-slate-600 max-w-2xl mx-auto lg:mx-0 leading-relaxed">
                                Compassionate, verified senior care. Connect with local caregivers trusted by families in San Jose, Palo Alto &amp; Mountain View.
                            </p>
                        </div>

                        {/* Zip code search — primary CTA embedded in a floating card */}
                        <div className="bg-white p-6 rounded-3xl shadow-xl shadow-primary-900/5 max-w-md mx-auto lg:mx-0 border border-slate-100">
                            <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
                                <div className="relative flex-1">
                                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                                    <input
                                        type="text"
                                        value={zipCode}
                                        onChange={(e) => setZipCode(e.target.value)}
                                        placeholder="Enter your zip code"
                                        className="w-full pl-11 pr-4 py-4 rounded-xl border border-slate-200 bg-slate-50 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-base transition-all"
                                        maxLength={5}
                                    />
                                </div>
                                <button
                                    type="submit"
                                    className="px-6 py-4 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl shadow-md shadow-primary-200 transition-all duration-200 hover:-translate-y-0.5 whitespace-nowrap flex items-center justify-center gap-2"
                                >
                                    Find Caregivers
                                    <ArrowRight className="w-4 h-4" />
                                </button>
                            </form>
                            <p className="text-xs text-slate-500 mt-4 text-center">
                                <span className="font-semibold text-slate-700">Typical:</span> $22–35/hr caregiver rate · No agency markup
                            </p>
                        </div>

                        {/* Trust pills */}
                        <div className="flex flex-wrap justify-center lg:justify-start gap-3">
                            {[
                                { icon: <CheckCircle className="w-4 h-4" />, text: 'Stripe Background Checked' },
                                { icon: <TrendingUp className="w-4 h-4" />, text: 'No Hidden Fees' },
                            ].map((item, i) => (
                                <div key={i} className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary-50 border border-primary-100 text-primary-700 text-sm font-medium">
                                    {item.icon}
                                    <span>{item.text}</span>
                                </div>
                            ))}
                            {/* Price advantage pill */}
                            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-accent-500 text-white text-sm font-semibold shadow-sm shadow-accent-200">
                                <Tag className="w-4 h-4" />
                                <span>Only $29.95/mo — 30% less than competitors</span>
                            </div>
                        </div>

                        {/* Stats row - simplified to 3 pillars */}
                        <div className="flex flex-wrap justify-center lg:justify-start gap-4 pt-4">
                            <div className="w-full sm:w-auto p-4 rounded-2xl bg-white/60 backdrop-blur-md border border-white/80 shadow-sm hover:shadow-md transition-shadow">
                                <div className="flex items-center gap-3">
                                    <div className="w-12 h-12 rounded-xl bg-primary-50 flex items-center justify-center">
                                        <DollarSign className="w-6 h-6 text-primary-600" />
                                    </div>
                                    <div className="text-left">
                                        <p className="text-lg font-bold text-slate-900">Affordable</p>
                                        <p className="text-sm text-slate-500">$22–35/hr, no agencies</p>
                                    </div>
                                </div>
                            </div>
                            <div className="w-full sm:w-auto p-4 rounded-2xl bg-white/60 backdrop-blur-md border border-white/80 shadow-sm hover:shadow-md transition-shadow">
                                <div className="flex items-center gap-3">
                                    <div className="w-12 h-12 rounded-xl bg-accent-50 flex items-center justify-center">
                                        <Clock className="w-6 h-6 text-accent-500" />
                                    </div>
                                    <div className="text-left">
                                        <p className="text-lg font-bold text-slate-900">Fast Matching</p>
                                        <p className="text-sm text-slate-500">Usually 24–48 hours</p>
                                    </div>
                                </div>
                            </div>
                            <div className="w-full sm:w-auto p-4 rounded-2xl bg-white/60 backdrop-blur-md border border-white/80 shadow-sm hover:shadow-md transition-shadow">
                                <div className="flex items-center gap-3">
                                    <div className="w-12 h-12 rounded-xl bg-green-50 flex items-center justify-center">
                                        <ShieldCheck className="w-6 h-6 text-green-600" />
                                    </div>
                                    <div className="text-left">
                                        <p className="text-lg font-bold text-slate-900">Verified Safe</p>
                                        <p className="text-sm text-slate-500">Stripe ID & Backgrounds</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right Content — Hero Image */}
                    <div className="flex-1 w-full max-w-lg lg:max-w-none">
                        <div className="relative">
                            <div className="relative rounded-[2.5rem] overflow-hidden shadow-2xl shadow-primary-900/10 border-8 border-white/60">
                                <img
                                    src="/assets/caregiver-senior-modern.png"
                                    alt="Warm moment between caregiver and senior — compassionate in-home care"
                                    className="w-full h-[480px] lg:h-[600px] object-cover"
                                />
                                {/* Subtle gradient overlay at bottom */}
                                <div className="absolute inset-0 bg-gradient-to-t from-slate-900/20 via-transparent to-transparent"></div>
                            </div>

                            {/* Verified badge */}
                            <div className="absolute bottom-10 right-[-1rem] md:right-[-2rem] bg-white rounded-2xl px-5 py-4 shadow-xl border border-slate-100 flex items-center gap-3 transform transition-transform hover:scale-105 hover:-translate-y-1">
                                <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                                    <ShieldCheck className="w-5 h-5 text-primary-600" />
                                </div>
                                <div>
                                    <p className="text-sm font-bold text-slate-900">Verified Caregiver</p>
                                    <p className="text-xs text-slate-500">Background checked</p>
                                </div>
                            </div>


                        </div>
                    </div>
                </div>

                {/* Cities bar */}
                <div className="py-6 border-t border-slate-100">
                    <p className="text-center text-slate-400 text-sm">
                        Serving:{' '}
                        {['San Jose', 'Santa Clara', 'Sunnyvale', 'Mountain View', 'Palo Alto', 'Cupertino', 'Los Gatos', 'Campbell', 'Milpitas'].map((city, i, arr) => (
                            <span key={city}>
                                <span className="text-slate-500">{city}</span>
                                {i < arr.length - 1 && <span className="mx-2">•</span>}
                            </span>
                        ))}
                    </p>
                </div>
            </div>
        </section>
    );
};
