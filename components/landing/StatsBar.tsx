import React from 'react';

const stats = [
    { value: '500+', label: 'Verified caregivers' },
    { value: '2,400+', label: 'Families matched' },
    { value: '94%', label: 'First-match success' },
    { value: '4.9', label: 'Average rating' },
];

export const StatsBar: React.FC = () => {
    return (
        <div className="bg-paper-50 border-b hairline">
            <div className="max-w-5xl mx-auto px-6 py-14">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-10">
                    {stats.map((stat, i) => (
                        <div key={i} className="text-center">
                            <p className="font-display text-4xl md:text-[44px] font-medium text-ink-900 tracking-tight">{stat.value}</p>
                            <p className="text-sm text-ink-400 mt-2">{stat.label}</p>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
