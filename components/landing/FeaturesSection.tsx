import React from 'react';
import { Edit, Star, MessageSquare } from 'lucide-react';
import { ViewType } from '../../types';

interface FeaturesSectionProps {
    onNavigate: (view: ViewType) => void;
}

export const FeaturesSection: React.FC<FeaturesSectionProps> = ({ onNavigate }) => {
    return (
        <section className="bg-paper-50 border-t hairline">
            <div className="max-w-6xl mx-auto px-6 py-20 lg:py-28 flex flex-col md:flex-row items-center gap-12 lg:gap-20">
                {/* Left Image Half */}
                <div className="md:w-1/2 w-full">
                    <div className="rounded-3xl overflow-hidden" style={{ boxShadow: '0 24px 60px rgba(26,31,43,0.10)' }}>
                        <img
                            src="/caregiver-door-greeting.png"
                            alt="Caregiver arriving to greet senior at the door"
                            className="w-full h-[380px] md:h-[460px] object-cover"
                        />
                    </div>
                </div>

                {/* Right Content Half */}
                <div className="md:w-1/2 w-full">
                    <p className="section-number mb-4">(2)</p>
                    <h2 className="font-display text-4xl lg:text-[42px] font-semibold text-ink-900 mb-4 tracking-[-0.02em] leading-[1.1]">
                        Caregivers come to you
                    </h2>
                    <p className="text-ink-600 text-[17px] mb-10 leading-relaxed max-w-md">
                        Tell Evia what you need once. She does the sourcing,
                        vetting, and scheduling — and keeps you posted by text.
                    </p>

                    <div className="space-y-0 border-t hairline mb-10">
                        {[
                            { icon: MessageSquare, text: 'Text Evia what you need — schedule, health conditions, preferences' },
                            { icon: Star, text: 'Evia sources, filters, and interviews top local caregivers for you' },
                            { icon: Edit, text: 'Evia schedules the visits and sends you updates via text' },
                        ].map(({ icon: Icon, text }, i) => (
                            <div key={i} className="flex items-center gap-5 py-5 border-b hairline">
                                <Icon className="w-5 h-5 text-ink-900 flex-shrink-0" strokeWidth={2} />
                                <p className="text-ink-600 text-[16px]">{text}</p>
                            </div>
                        ))}
                    </div>

                    <button
                        onClick={() => onNavigate('client-signup')}
                        className="btn-depth-primary px-8 py-3.5 rounded-full font-semibold text-sm"
                    >
                        Get started
                    </button>
                </div>
            </div>
        </section>
    );
};
