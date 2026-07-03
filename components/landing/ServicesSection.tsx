import React from 'react';
import { Heart, Brain, Coffee, Activity, UserPlus, Moon } from 'lucide-react';
import { ViewType } from '../../types';

interface ServicesSectionProps {
    onNavigate: (view: ViewType) => void;
}

const services = [
    {
        icon: <Heart className="w-8 h-8 text-[#e91e63]" strokeWidth={1.5} />,
        title: "Companion Care",
        description: "Assistance with daily activities, light housekeeping, and social engagement to keep your loved ones active, happy, and independent at home.",
        bgColor: "bg-teal-50"
    },
    {
        icon: <Brain className="w-8 h-8 text-[#0070ba]" strokeWidth={1.5} />,
        title: "Dementia & Alzheimer's Care",
        description: "Specialized, compassionate care from experienced professionals trained to support memory loss, handle behavioral changes, and ensure safety.",
        bgColor: "bg-blue-50"
    },
    {
        icon: <Coffee className="w-8 h-8 text-[#f59e0b]" strokeWidth={1.5} />,
        title: "Respite Care",
        description: "Temporary relief for family caregivers. Take a much-needed break to rest and recharge, knowing your loved one is in safe, capable hands.",
        bgColor: "bg-amber-50"
    },
    {
        icon: <Activity className="w-8 h-8 text-[#10b981]" strokeWidth={1.5} />,
        title: "Post-Surgery Recovery",
        description: "Help with mobility, medication reminders, and comfort during the critical transition from hospital to home to ensure a smooth recovery.",
        bgColor: "bg-emerald-50"
    },
    {
        icon: <UserPlus className="w-8 h-8 text-[#8b5cf6]" strokeWidth={1.5} />,
        title: "Personal Care",
        description: "Dignified and respectful assistance with bathing, dressing, grooming, hygiene, and other essential daily routines.",
        bgColor: "bg-blue-50"
    },
    {
        icon: <Moon className="w-8 h-8 text-[#3b82f6]" strokeWidth={1.5} />,
        title: "Overnight & 24/7 Care",
        description: "Continuous peace of mind with a professional present throughout the night or around the clock to assist with any immediate needs.",
        bgColor: "bg-indigo-50"
    }
];

export const ServicesSection: React.FC<ServicesSectionProps> = ({ onNavigate }) => {
    return (
        <section className="bg-white py-24 border-t border-slate-100">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="text-center max-w-3xl mx-auto mb-16">
                    <p className="section-number mb-4">(3)</p>
                    <h2 className="font-display text-4xl md:text-[42px] font-semibold text-ink-900 mb-6 tracking-[-0.02em]">
                        Comprehensive care tailored to your needs
                    </h2>
                    <p className="text-lg text-slate-600 leading-relaxed">
                        Find the perfect match for your loved one. Our network of verified caregivers specializes in a wide range of essential in-home senior care services.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {services.map((service, index) => (
                        <div 
                            key={index} 
                            className="bg-white rounded-3xl p-8 border border-slate-100 shadow-sm hover:shadow-xl hover:border-slate-200 transition-all duration-300 group cursor-pointer"
                            onClick={() => onNavigate('client-signup')}
                        >
                            <div className={`w-16 h-16 rounded-2xl ${service.bgColor} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300`}>
                                {service.icon}
                            </div>
                            <h3 className="text-xl font-bold text-slate-900 mb-3 tracking-tight">
                                {service.title}
                            </h3>
                            <p className="text-slate-600 leading-relaxed text-[15px]">
                                {service.description}
                            </p>
                            
                            <div className="mt-6 flex items-center text-primary-600 font-semibold text-sm group-hover:gap-2 transition-all">
                                Find caregivers <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="mt-16 text-center">
                    <button 
                        onClick={() => window.location.href = '/start?role=client'}
                        className="btn-depth-primary px-8 py-4 rounded-2xl font-semibold text-sm flex items-center justify-center"
                    >
                        Find Your Caregiver
                    </button>
                </div>
            </div>
        </section>
    );
};
