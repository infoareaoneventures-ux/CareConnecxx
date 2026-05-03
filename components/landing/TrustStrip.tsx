import React from 'react';

export const TrustStrip: React.FC = () => {
    return (
        <section className="border-y border-slate-100 bg-slate-50 py-8">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
                <p className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-6">Trusted by families in 50 states</p>
                <div className="flex flex-wrap justify-center gap-8 md:gap-16 opacity-50 grayscale">
                    {/* Mock Logos */}
                    <div className="text-xl font-bold font-serif text-slate-600">Forbes</div>
                    <div className="text-xl font-bold font-sans text-slate-600">TechCrunch</div>
                    <div className="text-xl font-bold font-serif text-slate-600">AARP</div>
                    <div className="text-xl font-bold font-mono text-slate-600">Healthline</div>
                </div>
            </div>
        </section>
    );
};
