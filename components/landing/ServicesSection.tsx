import React from 'react';
import { ViewType } from '../../types';
import { PRIMARY_SERVICES, serviceLabel } from '../caregiver/signup/constants';

interface ServicesSectionProps {
    onNavigate: (view: ViewType) => void;
}

// The SAME eight services the caregiver profile and the family's job post use
// (components/caregiver/signup/constants.ts PRIMARY_SERVICES, mirrored in
// functions/src/agents/caregiverServiceLabels.ts) — nothing invented, shown by
// their display label ("Medication Reminders" reads "Medication Reminders Only").
// One plain, non-medical sentence each (founder, 2026-10-12).
type Service = (typeof PRIMARY_SERVICES)[number];

const SERVICE_COPY: Record<Service, { description: string }> = {
    'Companionship': {
        description: 'Company and conversation at home — a visit, a walk, a game of cards, someone to share the afternoon with.',
    },
    'Personal Care': {
        description: 'A respectful hand with bathing, dressing, grooming and the other routines of the day.',
    },
    'Light Housekeeping': {
        description: 'Tidying, laundry, dishes and keeping the home comfortable to live in.',
    },
    'Meal Preparation': {
        description: 'Planning and cooking everyday meals, and company at the table.',
    },
    'Medication Reminders': {
        description: 'A reminder when it is time to take what is already prescribed. Care providers never administer or manage medication.',
    },
    'Mobility Assistance': {
        description: 'A steady arm getting up, moving around the home and heading out the door.',
    },
    'Transportation': {
        description: 'Rides to appointments, errands and visits by a care provider whose driving record has been checked.',
    },
    'Dementia / Memory Care': {
        description: 'Companionship and daily-routine support for someone living with memory loss.',
    },
};

// Four highlighted as cards; the other four named in one line (founder,
// 2026-10-12: a full list reads as limiting — the family and the caregiver work
// out anything else non-medical through the Care Plan notes).
const FEATURED: readonly Service[] = ['Companionship', 'Personal Care', 'Meal Preparation', 'Dementia / Memory Care'];
const ALSO: readonly Service[] = ['Light Housekeeping', 'Medication Reminders', 'Mobility Assistance', 'Transportation'];
const SERVICE_ORDER: readonly Service[] = FEATURED;
const alsoLine = ALSO.map(serviceLabel);

export const ServicesSection: React.FC<ServicesSectionProps> = ({ onNavigate }) => {
    return (
        <section className="bg-white py-24 border-t border-slate-100">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="text-center max-w-3xl mx-auto mb-16">
                    <p className="section-number mb-4">(2)</p>
                    <h2 className="font-display text-4xl md:text-[42px] font-semibold text-ink-900 mb-6 tracking-[-0.02em]">
                        Care that fits your needs
                    </h2>
                    <p className="text-lg text-slate-600 leading-relaxed">
                        Every care provider on Evia lists the services they offer. Tell Evia what your loved one needs.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
                    {SERVICE_ORDER.map((name) => {
                        const service = SERVICE_COPY[name];
                        return (
                            <div
                                key={name}
                                role="link"
                                tabIndex={0}
                                className="bg-white rounded-3xl p-8 border border-slate-100 shadow-sm hover:shadow-xl hover:border-slate-200 transition-all duration-300 group cursor-pointer"
                                onClick={() => onNavigate('client-apply')}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate('client-apply'); } }}
                            >
                                                                <h3 className="text-xl font-bold text-slate-900 mb-3 tracking-tight">
                                    {serviceLabel(name)}
                                </h3>
                                <p className="text-slate-600 leading-relaxed text-[15px]">
                                    {service.description}
                                </p>

                                <div className="mt-6 flex items-center text-primary-600 font-semibold text-sm group-hover:gap-2 transition-all">
                                    Find care providers <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="mt-12 max-w-3xl mx-auto text-center">
                    <p className="text-slate-600 leading-relaxed text-[15px]">
                        Care providers also offer {alsoLine.slice(0, -1).join(', ')} and {alsoLine[alsoLine.length - 1]}.
                    </p>
                </div>

                <div className="mt-12 text-center">
                    <button
                        onClick={() => onNavigate('client-apply')}
                        className="btn-depth-primary px-8 py-4 rounded-2xl font-semibold text-sm inline-flex items-center justify-center"
                    >
                        Find Your Care Provider
                    </button>
                </div>
            </div>
        </section>
    );
};
