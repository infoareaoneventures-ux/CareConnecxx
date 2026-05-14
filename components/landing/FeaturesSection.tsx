import React from 'react';
import { Edit, Star, MessageSquare } from 'lucide-react';
import { ViewType } from '../../types';

interface FeaturesSectionProps {
    onNavigate: (view: ViewType) => void;
}

export const FeaturesSection: React.FC<FeaturesSectionProps> = ({ onNavigate }) => {
    return (
        <section className="bg-[#f0ece6] flex flex-col md:flex-row min-h-[600px] w-full overflow-hidden">
            {/* Left Image Half */}
            <div className="md:w-1/2 relative h-[400px] md:h-auto overflow-hidden">
                <img 
                    src="/caregiver-door-greeting.png" 
                    alt="Caregiver arriving to greet senior at the door"
                    className="absolute inset-0 w-full h-full object-cover"
                />
            </div>

            {/* Right Content Half */}
            <div className="md:w-1/2 px-8 py-16 lg:px-20 lg:py-24 flex items-center">
                <div className="max-w-lg w-full">
                    <h2 className="text-3xl lg:text-4xl font-extrabold text-black mb-1 tracking-[-0.04em]">
                        How it works:
                    </h2>
                    <h2 className="text-3xl lg:text-4xl font-extrabold text-black mb-10 tracking-[-0.04em]">
                        Caregivers come to you
                    </h2>

                    <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-200 mb-8">
                        {/* Step 1 */}
                        <div className="flex items-center gap-5 p-5 md:p-6 border-b border-slate-100">
                            <MessageSquare className="w-[22px] h-[22px] text-slate-800 flex-shrink-0" strokeWidth={2.5} />
                            <p className="text-slate-700 font-medium text-[15px] md:text-[17px]">Text Cara what you need (schedule, health conditions)</p>
                        </div>
                        {/* Step 2 */}
                        <div className="flex items-center gap-5 p-5 md:p-6 border-b border-slate-100">
                            <Star className="w-[22px] h-[22px] text-slate-800 flex-shrink-0" strokeWidth={2.5} />
                            <p className="text-slate-700 font-medium text-[15px] md:text-[17px]">Cara sources, filters, and interviews top local caregivers for you</p>
                        </div>
                        {/* Step 3 */}
                        <div className="flex items-center gap-5 p-5 md:p-6">
                            <Edit className="w-[22px] h-[22px] text-slate-800 flex-shrink-0" strokeWidth={2.5} />
                            <p className="text-slate-700 font-medium text-[15px] md:text-[17px]">Cara schedules the visits and sends you updates via text</p>
                        </div>
                    </div>

                    <button 
                        onClick={() => onNavigate('client-signup')}
                        className="btn-depth-primary px-8 py-3.5 rounded-2xl font-semibold text-sm flex items-center justify-center"
                    >
                        Get Started
                    </button>
                </div>
            </div>
        </section>
    );
};
