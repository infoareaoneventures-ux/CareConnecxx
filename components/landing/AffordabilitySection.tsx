import React from 'react';
import { TrendingUp, Users, DollarSign, Heart, ArrowRight, ShieldCheck } from 'lucide-react';
import { ViewType } from '../../types';
import { Button } from '../ui/Button';

interface AffordabilitySectionProps {
    onNavigate: (view: ViewType) => void;
}

export const AffordabilitySection: React.FC<AffordabilitySectionProps> = ({ onNavigate }) => {
    return (
        <section className="py-24 relative overflow-hidden bg-white">
            {/* Soft decorative background */}
            <div className="absolute top-0 right-0 -translate-y-1/2 translate-x-1/2 w-[600px] h-[600px] bg-primary-50 rounded-full blur-3xl opacity-50 pointer-events-none"></div>

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
                {/* Header Section */}
                <div className="text-center max-w-3xl mx-auto mb-20 animate-fade-in">
                    <h2 className="text-4xl md:text-5xl font-bold text-slate-900 mb-6 leading-tight">
                        Home Care Costs Are Rising—<br className="hidden md:block" />
                        <span className="text-primary-600">But Help Shouldn't Be Out of Reach</span>
                    </h2>
                    <p className="text-xl text-slate-600 mb-4">
                        Since 2021, home care expenses have increased by <span className="font-bold text-slate-900">20-40%</span>, yet only about <span className="font-bold text-slate-900">14% of seniors</span> can fully afford standard care out-of-pocket.
                    </p>
                    <p className="text-sm text-slate-400 italic">
                        Source: Home Health Care News
                    </p>
                </div>

                <div className="grid lg:grid-cols-2 gap-16 items-center">
                    {/* The Reality Card */}
                    <div className="bg-slate-50/80 backdrop-blur-sm border border-slate-100 p-8 md:p-12 rounded-[2.5rem] shadow-xl shadow-slate-200/50">
                        <h3 className="text-2xl font-bold text-slate-900 mb-8 flex items-center">
                            The Reality Families Face Today
                        </h3>
                        <ul className="space-y-6">
                            {[
                                { title: "Confusing pricing", desc: "with hidden fees and agency markups", icon: <DollarSign className="w-5 h-5" /> },
                                { title: "Overwhelming caregiving process", desc: "with poor caregiver matching", icon: <Users className="w-5 h-5" /> },
                                { title: "Emotional and logistical stress", desc: "navigating complex care systems", icon: <Heart className="w-5 h-5" /> },
                                { title: "Lack of personal support", desc: "when you need it most", icon: <ShieldCheck className="w-5 h-5" /> }
                            ].map((item, i) => (
                                <li key={i} className="flex items-start gap-4">
                                    <div className="mt-1 bg-red-100 p-2 rounded-lg text-red-600">
                                        {item.icon}
                                    </div>
                                    <div>
                                        <span className="font-bold text-slate-900 block">{item.title}</span>
                                        <span className="text-slate-600">{item.desc}</span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                        <div className="mt-10 pt-8 border-t border-slate-200/60">
                            <p className="text-lg font-medium text-slate-700 italic">
                                "Caring for a loved one should not be this stressful."
                            </p>
                        </div>
                    </div>

                    {/* The Solution Section */}
                    <div className="space-y-10">
                        <div className="space-y-6">
                            <h3 className="text-3xl font-bold text-slate-900">
                                CareConnex Is Here to Fix That
                            </h3>
                            <p className="text-xl text-slate-600 leading-relaxed">
                                Our platform provides <span className="font-bold text-primary-600">transparent, affordable pricing</span> with <span className="font-bold text-primary-600">AI-driven caregiver matching</span> and <span className="font-bold text-primary-600">real-time support</span> to make finding and managing care simple and compassionate.
                            </p>
                        </div>

                        <div className="grid sm:grid-cols-2 gap-6">
                            <div className="bg-primary-50/50 p-6 rounded-3xl border border-primary-100 flex flex-col items-start gap-4 transition-transform hover:-translate-y-1">
                                <div className="bg-primary-600 p-3 rounded-2xl text-white shadow-lg shadow-primary-200">
                                    <TrendingUp className="w-6 h-6" />
                                </div>
                                <div>
                                    <h4 className="font-bold text-slate-900">Direct Savings</h4>
                                    <p className="text-sm text-slate-600">Save 30-40% on Santa Clara County agency rates ($32-42/hr → $22-28/hr).</p>
                                </div>
                            </div>
                            <div className="bg-blue-50/50 p-6 rounded-3xl border border-blue-100 flex flex-col items-start gap-4 transition-transform hover:-translate-y-1">
                                <div className="bg-blue-600 p-3 rounded-2xl text-white shadow-lg shadow-blue-200">
                                    <ShieldCheck className="w-6 h-6" />
                                </div>
                                <div>
                                    <h4 className="font-bold text-slate-900">AI Match</h4>
                                    <p className="text-sm text-slate-600">Find the perfect caregiver based on skills & personality.</p>
                                </div>
                            </div>
                        </div>

                        <div className="pt-4">
                            <Button
                                size="lg"
                                onClick={() => onNavigate('client-signup')}
                                className="group px-8 rounded-2xl"
                            >
                                Start Saving on Care
                                <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
};
