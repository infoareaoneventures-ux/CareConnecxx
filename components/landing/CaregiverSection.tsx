import React from 'react';
import { ViewType } from '../../types';

interface CaregiverSectionProps {
    onNavigate: (view: ViewType) => void;
}

export const CaregiverSection: React.FC<CaregiverSectionProps> = ({ onNavigate }) => {
    return (
        <section className="bg-paper-100 border-t hairline py-16 md:py-24">
            <div className="max-w-6xl mx-auto px-6 lg:px-8">
                <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">
                    
                    {/* Left Column: Image with Testimonial Badge */}
                    <div className="w-full lg:w-1/2 relative">
                        <div className="rounded-[32px] overflow-hidden shadow-xl shadow-teal-900/10">
                            <img 
                                src="/assets/caregiver-senior-porch.png" 
                                alt="Caregiver and senior enjoying time together on a porch" 
                                className="w-full h-auto object-cover"
                            />
                        </div>
                        
                        {/* Testimonial Badge Overlay */}
                        <div className="absolute -bottom-6 left-6 md:left-10 bg-white p-5 rounded-2xl shadow-lg border border-slate-100 max-w-[280px] md:max-w-[320px]">
                            <p className="text-slate-800 font-medium leading-snug mb-3">
                                "I found a forever caregiver here and will always recommend this platform."
                            </p>
                            <div className="flex items-center gap-2">
                                <span className="text-[#e91e63] font-bold">Brittany S.</span>
                                <span className="text-xs text-slate-500 uppercase tracking-wider">Verified Family</span>
                            </div>
                        </div>
                    </div>

                    {/* Right Column: Text & Buttons */}
                    <div className="w-full lg:w-1/2 lg:pl-8 pt-8 lg:pt-0">
                        <h2 className="font-display text-4xl md:text-[46px] font-semibold text-ink-900 leading-[1.08] mb-10 tracking-[-0.02em] max-w-xl">
                            Get started with just a text
                        </h2>

                        <div className="flex flex-col sm:flex-row items-center gap-5">
                            <button
                                onClick={() => onNavigate('client-signup')}
                                className="btn-depth-primary px-8 py-4 rounded-full font-semibold text-center text-[15px]"
                            >
                                Get started
                            </button>

                            <button
                                onClick={() => window.location.href = '/login'}
                                className="text-ink-600 hover:text-ink-900 font-medium text-[15px] transition-colors"
                            >
                                Log in →
                            </button>
                        </div>
                    </div>

                </div>
            </div>
        </section>
    );
};
