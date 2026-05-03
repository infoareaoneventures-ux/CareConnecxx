import React from 'react';
import { ShieldCheck, UserCheck, Lock, Search } from 'lucide-react';
import { ViewType } from '../../types';

interface TrustSafetySectionProps {
    onNavigate: (view: ViewType) => void;
}

const trustPoints = [
    { icon: <ShieldCheck className="w-6 h-6" strokeWidth={1.5} />, title: 'Buy background checks' },
    { icon: <UserCheck className="w-6 h-6" strokeWidth={1.5} />, title: 'Identity verification' },
    { icon: <Lock className="w-6 h-6" strokeWidth={1.5} />, title: 'Fraud prevention' },
    { icon: <Search className="w-6 h-6" strokeWidth={1.5} />, title: 'Safety screenings' },
];

const testimonials = [
    {
        quote: "It's easy and I always find a caregiver!",
        name: "Jennifer R.",
        memberSince: "2022"
    },
    {
        quote: "CareConnex is efficient, trustworthy, and has helped me in a bind many times.",
        name: "Annika D.",
        memberSince: "2014"
    }
];

export const TrustSafetySection: React.FC<TrustSafetySectionProps> = ({ onNavigate }) => {
    return (
        <section className="bg-[#fafaf9] relative overflow-hidden pt-20 pb-32">
            <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
                <div className="flex flex-col lg:flex-row items-center lg:items-end justify-between gap-12 lg:gap-8">
                    
                    {/* Left Column: Text & Features */}
                    <div className="w-full lg:w-1/3 pb-8 lg:pb-16 z-10 relative">
                        <h2 className="text-4xl md:text-5xl font-extrabold text-slate-900 leading-[1.1] mb-6 tracking-tight">
                            A proven network of reliable, trustworthy care
                        </h2>
                        <p className="text-slate-600 text-[17px] mb-10 leading-relaxed max-w-md">
                            Our dedicated team is working hard behind the scenes every day. For more information about our commitment to safety, visit the <a href="#" className="underline font-medium hover:text-primary-600 text-slate-800 transition-colors">Trust and Safety Center.</a>
                        </p>
                        
                        <div className="space-y-6">
                            {trustPoints.map((point, i) => (
                                <div key={i} className="flex items-center gap-5 group">
                                    <div className="text-slate-800 flex-shrink-0 group-hover:scale-110 transition-transform">
                                        {point.icon}
                                    </div>
                                    <h3 className="text-[17px] text-slate-700">{point.title}</h3>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Middle Column: Image */}
                    <div className="w-full lg:w-1/3 flex justify-center z-0 relative">
                        <img 
                            src="/assets/caregiver-senior-trust.png" 
                            alt="Caregiver and senior sitting together" 
                            className="w-full max-w-[400px] lg:max-w-[450px] xl:max-w-[500px] h-auto mix-blend-multiply translate-y-4 lg:translate-y-24"
                        />
                    </div>

                    {/* Right Column: Testimonials */}
                    <div className="w-full lg:w-1/3 z-10 flex flex-col gap-6 pb-8 lg:pb-16 relative">
                        {testimonials.map((test, i) => (
                            <div key={i} className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200/60 flex flex-col relative transform transition-all hover:shadow-md hover:-translate-y-1">
                                <div className="text-[#e91e63] text-5xl font-serif font-black absolute top-5 left-6 leading-none">“</div>
                                <p className="text-slate-800 text-lg md:text-[20px] leading-relaxed mb-10 mt-6 relative z-10 font-medium">
                                    {test.quote}
                                </p>
                                <div className="mt-auto">
                                    <p className="text-[#e91e63] text-2xl font-bold mb-1 tracking-tight">{test.name}</p>
                                    <p className="text-[11px] text-slate-500 uppercase tracking-wide font-semibold">Verified Family</p>
                                </div>
                            </div>
                        ))}
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
