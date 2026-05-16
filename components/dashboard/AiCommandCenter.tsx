import React from 'react';
import { Phone, Calendar, UserCheck, Clock } from 'lucide-react';
import { SlideUp } from '../ui/Motion';
import { AddToastFunction } from '../../types';

interface AiCommandCenterProps {
    onSearch?: (query: string) => void;
    onShowToast: AddToastFunction;
}

export const AiCommandCenter: React.FC<AiCommandCenterProps> = ({ onShowToast }) => {
    const handleCallCoordinator = () => {
        // In a real app, this would initiate a call or open a scheduling modal
        onShowToast("Connecting you with a care coordinator...", 'info');
        window.location.href = `tel:${import.meta.env.VITE_SUPPORT_PHONE || ''}`;
    };

    return (
        <SlideUp>
            <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-3xl p-8 md:p-10 text-white shadow-2xl mb-8 relative overflow-hidden">
                {/* Decorative Background Elements */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl"></div>
                <div className="absolute bottom-0 left-0 w-48 h-48 bg-blue-400/10 rounded-full blur-2xl"></div>

                <div className="relative z-10">
                    {/* Header */}
                    <div className="text-center mb-8">
                        <h2 className="text-3xl md:text-4xl font-bold mb-3">Your Personal Care Coordinator</h2>
                        <p className="text-blue-100 text-lg max-w-2xl mx-auto">
                            Let our experienced care coordinators find the perfect caregiver match for your family. 
                            We handle the search, screening, and scheduling so you don't have to.
                        </p>
                    </div>

                    {/* Benefits Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                        {[
                            { icon: UserCheck, label: 'Expert Matching', desc: 'Personalized caregiver selection' },
                            { icon: Clock, label: 'Fast Response', desc: 'Within 2 hours' },
                            { icon: Calendar, label: 'Flexible Scheduling', desc: 'Works around your needs' },
                            { icon: Phone, label: 'Ongoing Support', desc: 'Available 24/7' },
                        ].map((benefit, index) => (
                            <div key={index} className="bg-white/10 backdrop-blur-sm rounded-xl p-4 text-center">
                                <benefit.icon className="w-8 h-8 mx-auto mb-2 text-blue-100" />
                                <h3 className="font-semibold text-white text-sm">{benefit.label}</h3>
                                <p className="text-blue-100 text-xs mt-1">{benefit.desc}</p>
                            </div>
                        ))}
                    </div>

                    {/* CTA Button */}
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                        <button
                            onClick={handleCallCoordinator}
                            className="w-full sm:w-auto bg-white text-blue-600 px-8 py-4 rounded-xl font-bold text-lg hover:bg-blue-50 transition-all shadow-lg hover:shadow-xl flex items-center justify-center gap-3"
                        >
                            <Phone className="w-6 h-6" />
                            Call Care Coordinator
                        </button>
                        <a 
                            href="mailto:coordinator@careconnex.com"
                            className="w-full sm:w-auto bg-white/20 hover:bg-white/30 border-2 border-white/40 text-white px-8 py-4 rounded-xl font-bold text-lg transition-all flex items-center justify-center gap-3"
                        >
                            <Calendar className="w-6 h-6" />
                            Schedule a Call
                        </a>
                    </div>

                    {/* Trust Indicators */}
                    <div className="mt-8 pt-6 border-t border-white/20 text-center">
                        <p className="text-blue-100 text-sm">
                            ✓ Background-checked caregivers &nbsp;•&nbsp; 
                            ✓ Licensed & insured &nbsp;•&nbsp; 
                            ✓ Satisfaction guaranteed
                        </p>
                    </div>
                </div>
            </div>
        </SlideUp>
    );
};
