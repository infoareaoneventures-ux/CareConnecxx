import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ViewType } from '../../types';

interface FAQSectionProps {
    onNavigate: (view: ViewType) => void;
}

export const faqs = [
    {
        question: "How do you screen your caregivers?",
        answer: "Every caregiver undergoes a rigorous 5-step screening process: comprehensive background check (criminal + DMV), identity verification, reference checks from previous employers, skills assessment, and a personal interview. All care on Evia is non-medical in-home care.",
        category: "Safety"
    },
    {
        question: "What if I don't like the caregiver you match me with?",
        answer: "No problem. Our AI matching is highly accurate, but if you're not completely satisfied, just text Evia. She will find a new match immediately—no questions asked, no fees. We can even schedule video interviews with up to 3 candidates so you can choose the best fit.",
        category: "Matching"
    },
    {
        question: "Is my parent's personal information secure?",
        answer: "Absolutely. We're HIPAA-compliant and use bank-level encryption (AES-256) for all data. Caregivers only receive the specific information they need for care. Full medical history and sensitive documents stay private and are managed securely by Evia.",
        category: "Privacy"
    },
    {
        question: "Can I change or cancel care anytime?",
        answer: "Yes. There are no long-term contracts or cancellation fees. You can modify schedules, change caregivers, or pause service with just 24 hours notice. You're in complete control of your care.",
        category: "Flexibility"
    },
    {
        question: "How much does it cost compared to traditional agencies?",
        answer: "In Santa Clara County, traditional agencies typically charge $32-42/hour while paying caregivers only $18-22/hour. With Evia, families pay the caregiver’s own hourly rate plus a flat $29.95/month membership and a per-visit service fee — caregivers keep 100% of their rate. No agency markup and no long-term contracts.",
        category: "Pricing"
    },
    {
        question: "What types of care do you offer?",
        answer: "We offer comprehensive in-home care: companionship, personal care (bathing, dressing, grooming), meal preparation, medication reminders, transportation, light housekeeping, dementia/Alzheimer's care, respite care for family caregivers, and overnight or 24/7 live-in care.",
        category: "Services"
    },
    {
        question: "How quickly can I get a caregiver?",
        answer: "Most families find a match within 24-48 hours. For urgent needs, Evia can often source pre-approved caregivers to start the same day. Just text her your urgent needs and she'll begin matching immediately.",
        category: "Timing"
    },
    {
        question: "What happens if a caregiver calls in sick?",
        answer: "We've got you covered. Evia automatically notifies you via text and instantly suggests backup caregivers from your area who are available. For recurring care, she can even help you maintain a primary and backup caregiver to ensure continuity.",
        category: "Reliability"
    }
];

export const FAQSection: React.FC<FAQSectionProps> = ({ onNavigate }) => {
    const [openIndex, setOpenIndex] = useState<number | null>(0);

    return (
        <section className="py-24 bg-paper-50 border-t hairline relative overflow-hidden">

            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
                {/* Header */}
                <div className="text-center mb-16">
                    <h2 className="font-display text-4xl md:text-[42px] font-semibold text-ink-900 mb-5 tracking-[-0.02em]">
                        Questions, answered
                    </h2>
                    <p className="text-lg text-ink-600 max-w-2xl mx-auto">
                        Everything you need to know about finding and managing care with Evia.
                    </p>
                </div>

                {/* FAQ Items */}
                <div className="space-y-4">
                    {faqs.map((faq, index) => (
                        <div 
                            key={index}
                            className="border border-slate-200 rounded-2xl overflow-hidden hover:border-primary-200 transition-colors"
                        >
                            <button
                                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                                className="w-full flex items-center justify-between p-6 text-left bg-white hover:bg-slate-50 transition-colors"
                            >
                                <div className="flex items-start gap-4">
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 mt-1">
                                        {faq.category}
                                    </span>
                                    <span className="font-semibold text-slate-900 text-lg">
                                        {faq.question}
                                    </span>
                                </div>
                                {openIndex === index ? (
                                    <ChevronUp className="w-5 h-5 text-primary-600 flex-shrink-0 ml-4" />
                                ) : (
                                    <ChevronDown className="w-5 h-5 text-slate-400 flex-shrink-0 ml-4" />
                                )}
                            </button>
                            
                            {openIndex === index && (
                                <div className="px-6 pb-6 bg-slate-50/50">
                                    <div className="pl-[calc(3.5rem+4px)]">
                                        <p className="text-slate-600 leading-relaxed">
                                            {faq.answer}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {/* CTA */}
                <div className="mt-16 text-center bg-white border hairline rounded-3xl p-12">
                    <h3 className="font-display text-2xl font-semibold text-ink-900 mb-4">
                        Still have questions?
                    </h3>
                    <p className="text-ink-600 mb-8 max-w-lg mx-auto">
                        Our care advisors are here to help. Schedule a free 15-minute consultation to discuss your specific needs.
                    </p>
                    <div className="flex flex-col sm:flex-row items-center gap-5 justify-center">
                        <button
                            onClick={() => onNavigate('client-signup')}
                            className="btn-depth-primary px-8 py-3.5 rounded-full font-semibold text-sm"
                        >
                            Get started
                        </button>
                        <button
                            onClick={() => window.location.href = 'mailto:support@eviacares.com'}
                            className="text-ink-600 hover:text-ink-900 font-medium text-[15px] transition-colors"
                        >
                            Contact support →
                        </button>
                    </div>
                </div>
            </div>
        </section>
    );
};
