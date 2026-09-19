import React, { useState } from 'react';
import { Check, X, Shield, Heart, Clock, Users, ChevronDown, ChevronUp, ArrowRight, Sparkles } from 'lucide-react';
import { ViewType } from '../types';
import { Button } from './ui/Button';
import { SEO } from './SEO';

interface SubscriptionProps {
    onNavigate: (view: ViewType) => void;
}

export const Subscription: React.FC<SubscriptionProps> = ({ onNavigate }) => {
    const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

    const faqs = [
        {
            question: "Can I cancel my subscription anytime?",
            answer: "Yes! You can cancel your subscription at any time with no penalties or fees. Your access will continue until the end of your current billing period."
        },
        {
            question: "What payment methods do you accept?",
            answer: "We accept all major credit cards (Visa, Mastercard, American Express, Discover) and debit cards. Payments are processed securely through Stripe."
        },
        {
            question: "How much do caregivers pay?",
            answer: "Caregivers pay $54.99/year, which covers their required background check and full platform access. This keeps our caregiver pool high-quality and committed, which means better matches for families seeking care."
        },
        {
            question: "What's included in the $29.95/month fee?",
            answer: "Caregiver matching, background-checked caregivers, interview scheduling, shift clock-in/out with hours review, messaging, care plan tools, and Evia text support 24/7."
        },
        {
            question: "Do I pay caregivers separately?",
            answer: "Yes. The $29.95/month membership gives you access to the platform. You pay caregivers at the rate they set, plus a 9% service fee on each visit (minimum $1)."
        }
    ];

    const clientFeatures = [
        "AI-powered caregiver matching",
        "Comprehensive background checks",
        "Shift clock-in/out and hours review",
        "Automated tax forms (1099)",
        "Secure messaging & scheduling",
        "Evia text support, 24/7",
        "Care plan management tools",
        "Emergency alert button during visits",
        "Family manager access"
    ];

    const caregiverFeatures = [
        "Create professional profile",
        "Get matched with local families",
        "Flexible scheduling tools",
        "Secure payment processing",
        "Automated earnings tracking",
        "Background check assistance",
        "Training resources & certifications",
        "Direct messaging with clients",
        "Community support network"
    ];

    return (
        <>
            <SEO
                title="Pricing & Subscription Plans - Evia"
                description="Evia pricing: $29.95/month for families, $54.99/year for caregivers. Cancel anytime."
                keywords="caregiver pricing, senior care cost, caregiving subscription, affordable care platform, free for caregivers"
                canonicalUrl="https://www.eviacares.com/pricing"
            />

            <div className="min-h-screen bg-paper-50">
                {/* Header */}
                <header className="bg-white/80 backdrop-blur-md border-b hairline sticky top-0 z-40">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
                        <div className="flex items-center justify-between">
                            <button
                                onClick={() => onNavigate('landing')}
                                className="font-display text-2xl font-semibold text-ink-900 tracking-tight"
                            >
                                Evia
                            </button>

                            {/* Desktop Nav */}
                            <nav className="hidden md:flex items-center space-x-8">
                                <button onClick={() => onNavigate('client-signup')} className="text-ink-600 hover:text-ink-900 font-medium transition-colors">Find Care</button>
                                <button onClick={() => onNavigate('caregiver-signup')} className="text-ink-600 hover:text-ink-900 font-medium transition-colors">Find Jobs</button>
                                <button onClick={() => onNavigate('how-it-works')} className="text-ink-400 hover:text-ink-600 text-sm font-medium">How it Works</button>
                                <button onClick={() => onNavigate('subscription')} className="text-ink-600 hover:text-ink-900 font-medium transition-colors">Pricing</button>
                            </nav>

                            <div className="flex gap-3">
                                <Button variant="secondary" size="sm" onClick={() => onNavigate('login')}>
                                    Sign In
                                </Button>
                                <Button size="sm" onClick={() => onNavigate('client-signup')}>
                                    Get Started
                                </Button>
                            </div>
                        </div>
                    </div>
                </header>
                {/* Hero Section */}
                <section className="relative overflow-hidden pt-20 pb-16 bg-gradient-to-br from-slate-50 via-teal-50/30 to-blue-50/30">
                    {/* Background Blobs */}

                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
                        <div className="text-center max-w-4xl mx-auto">
                            <div className="inline-flex items-center px-4 py-2 rounded-full bg-paper-100 border hairline text-ink-600 text-sm font-medium mb-6">
                                <Sparkles className="w-4 h-4 mr-2" />
                                Simple, Transparent Pricing
                            </div>
                            <h1 className="font-display text-5xl lg:text-7xl font-semibold tracking-[-0.02em] text-ink-900 mb-6 tracking-tight">
                                Care that's <span className="text-ink-400">affordable</span> for everyone.
                            </h1>
                            <p className="text-xl text-ink-600 mb-8 leading-relaxed font-light max-w-2xl mx-auto">
                                One simple price for families. <span className="font-semibold text-ink-900">$54.99/year for caregivers.</span> Clear pricing, no surprises.
                            </p>
                        </div>
                    </div>
                </section>

                {/* Pricing Cards */}
                <section className="py-20 relative">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="grid lg:grid-cols-2 gap-8 max-w-5xl mx-auto">

                            {/* Client Pricing Card */}
                            <div className="relative group">
                                {/* Popular Badge */}
                                <div className="absolute -top-4 left-1/2 transform -translate-x-1/2 z-20">
                                    <div className="btn-depth-primary px-6 py-2 rounded-full text-sm font-semibold">
                                        Most Popular
                                    </div>
                                </div>

                                <div className="bg-white rounded-3xl border-2 border-ink-900 p-8 lg:p-10 transition-all duration-300 h-full">
                                    <div className="flex items-center gap-3 mb-6">
                                        <div className="bg-paper-100 p-3 rounded-2xl">
                                            <Heart className="w-8 h-8 text-ink-900" />
                                        </div>
                                        <div>
                                            <h3 className="text-2xl font-bold text-ink-900">For Families</h3>
                                            <p className="text-sm text-ink-600">Seeking quality care</p>
                                        </div>
                                    </div>

                                    <div className="mb-8">
                                        <div className="flex items-baseline gap-2 mb-2">
                                            <span className="text-6xl font-bold text-ink-900">$29</span>
                                            <span className="text-2xl text-ink-600">.95</span>
                                            <span className="text-ink-600 font-medium">/month</span>
                                        </div>
                                        <p className="text-sm text-ink-600">Cancel anytime • Clear pricing</p>
                                    </div>

                                    <div className="space-y-4 mb-8">
                                        {clientFeatures.map((feature, idx) => (
                                            <div key={idx} className="flex items-start gap-3">
                                                <div className="bg-paper-100 rounded-full p-1 mt-0.5 flex-shrink-0">
                                                    <Check className="w-4 h-4 text-primary-600" />
                                                </div>
                                                <span className="text-ink-600 font-medium">{feature}</span>
                                            </div>
                                        ))}
                                    </div>

                                    <Button
                                        fullWidth
                                        size="lg"
                                        onClick={() => onNavigate('client-signup')}
                                        className="rounded-2xl shadow-primary-500/30 hover:shadow-primary-500/50"
                                    >
                                        Get Started
                                        <ArrowRight className="w-5 h-5 ml-2" />
                                    </Button>
                                </div>
                            </div>

                            {/* Caregiver Pricing Card */}
                            <div className="relative">
                                <div className="bg-white rounded-3xl border hairline p-8 lg:p-10 transition-all duration-300 h-full">
                                    <div className="flex items-center gap-3 mb-6">
                                        <div className="bg-accent-100 p-3 rounded-2xl">
                                            <Shield className="w-8 h-8 text-ink-900" />
                                        </div>
                                        <div>
                                            <h3 className="text-2xl font-bold text-ink-900">For Caregivers</h3>
                                            <p className="text-sm text-ink-600">Providing compassionate care</p>
                                        </div>
                                    </div>

                                    <div className="mb-8">
                                        <div className="flex items-baseline gap-2 mb-2">
                                            <span className="font-display text-6xl font-semibold text-ink-900 tracking-[-0.02em]">$24</span>
                                            <span className="text-2xl text-ink-400">.95</span>
                                            <span className="text-ink-600 font-medium">/year</span>
                                        </div>
                                        <p className="text-sm text-ink-600">Annual membership • Cancel anytime</p>
                                    </div>

                                    <div className="space-y-4 mb-8">
                                        {caregiverFeatures.map((feature, idx) => (
                                            <div key={idx} className="flex items-start gap-3">
                                                <div className="bg-accent-100 rounded-full p-1 mt-0.5 flex-shrink-0">
                                                    <Check className="w-4 h-4 text-accent-500" />
                                                </div>
                                                <span className="text-ink-600 font-medium">{feature}</span>
                                            </div>
                                        ))}
                                    </div>

                                    <Button
                                        fullWidth
                                        size="lg"
                                        variant="accent"
                                        onClick={() => onNavigate('caregiver-signup')}
                                        className="rounded-2xl shadow-accent-500/30 hover:shadow-accent-500/50"
                                    >
                                        Join as Caregiver
                                        <ArrowRight className="w-5 h-5 ml-2" />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Value Proposition */}
                <section className="py-20 bg-white/50 backdrop-blur-sm">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="text-center mb-16">
                            <h2 className="font-display text-4xl lg:text-5xl font-semibold tracking-[-0.02em] text-ink-900 mb-4">
                                Why our pricing makes sense
                            </h2>
                            <p className="text-xl text-ink-600 max-w-3xl mx-auto">
                                Traditional agencies charge 30-50% more. We're transparent, affordable, and built for modern families.
                            </p>
                        </div>

                        <div className="grid md:grid-cols-3 gap-8">
                            <div className="bg-white/80 backdrop-blur-md rounded-3xl p-8 shadow-lg shadow-slate-200/50 border border-white/60 hover:-translate-y-1 transition-all">
                                <div className="bg-paper-100 w-16 h-16 rounded-2xl flex items-center justify-center mb-6">
                                    <Users className="w-8 h-8 text-blue-600" />
                                </div>
                                <h3 className="text-xl font-bold text-ink-900 mb-3">Direct Connection</h3>
                                <p className="text-ink-600 leading-relaxed">
                                    No middleman means lower costs. You connect directly with caregivers and negotiate rates that work for both of you.
                                </p>
                            </div>

                            <div className="bg-white/80 backdrop-blur-md rounded-3xl p-8 shadow-lg shadow-slate-200/50 border border-white/60 hover:-translate-y-1 transition-all">
                                <div className="bg-primary-100 w-16 h-16 rounded-2xl flex items-center justify-center mb-6">
                                    <Shield className="w-8 h-8 text-primary-600" />
                                </div>
                                <h3 className="text-xl font-bold text-ink-900 mb-3">Trust &amp; Safety</h3>
                                <p className="text-ink-600 leading-relaxed">
                                    Your subscription includes background checks, identity verification, and secure payments—peace of mind at an affordable price.
                                </p>
                            </div>

                            <div className="bg-white/80 backdrop-blur-md rounded-3xl p-8 shadow-lg shadow-slate-200/50 border border-white/60 hover:-translate-y-1 transition-all">
                                <div className="bg-paper-100 w-16 h-16 rounded-2xl flex items-center justify-center mb-6">
                                    <Clock className="w-8 h-8 text-blue-600" />
                                </div>
                                <h3 className="text-xl font-bold text-ink-900 mb-3">Flexible & Simple</h3>
                                <p className="text-ink-600 leading-relaxed">
                                    One flat monthly fee. No contracts, no hidden charges. Use as much or as little as you need, cancel anytime.
                                </p>
                            </div>
                        </div>
                    </div>
                </section>

                {/* FAQ Section */}
                <section className="py-20 relative overflow-hidden">

                    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
                        <div className="text-center mb-12">
                            <h2 className="font-display text-4xl lg:text-5xl font-semibold tracking-[-0.02em] text-ink-900 mb-4">
                                Frequently Asked Questions
                            </h2>
                            <p className="text-xl text-ink-600">
                                Everything you need to know about our pricing
                            </p>
                        </div>

                        <div className="space-y-4">
                            {faqs.map((faq, idx) => (
                                <div
                                    key={idx}
                                    className="bg-white/80 backdrop-blur-md rounded-2xl shadow-lg border border-white/60 overflow-hidden transition-all hover:shadow-xl"
                                >
                                    <button
                                        onClick={() => setExpandedFaq(expandedFaq === idx ? null : idx)}
                                        className="w-full px-6 py-5 flex items-center justify-between text-left hover:bg-paper-100/50 transition-colors"
                                    >
                                        <span className="font-semibold text-ink-900 text-lg pr-4">{faq.question}</span>
                                        {expandedFaq === idx ? (
                                            <ChevronUp className="w-5 h-5 text-primary-600 flex-shrink-0" />
                                        ) : (
                                            <ChevronDown className="w-5 h-5 text-ink-400 flex-shrink-0" />
                                        )}
                                    </button>
                                    {expandedFaq === idx && (
                                        <div className="px-6 pb-5 pt-0">
                                            <p className="text-ink-600 leading-relaxed">{faq.answer}</p>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* CTA Section */}
                <section className="py-20 bg-gradient-to-br from-primary-600 via-teal-500 to-blue-600 relative overflow-hidden">
                    <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAxMCAwIEwgMCAwIDAgMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS1vcGFjaXR5PSIwLjEiIHN0cm9rZS13aWR0aD0iMSIvPjwvcGF0dGVybj48L2RlZnM+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0idXJsKCNncmlkKSIvPjwvc3ZnPg==')] opacity-40"></div>

                    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
                        <h2 className="font-display text-4xl lg:text-5xl font-semibold tracking-[-0.02em] text-white mb-6">
                            Ready to find your perfect caregiver?
                        </h2>
                        <p className="text-xl text-primary-50 mb-10 max-w-2xl mx-auto">
                            Join thousands of families who've found trusted care through Evia. Get started today.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-4 justify-center">
                            <Button
                                size="lg"
                                variant="secondary"
                                onClick={() => onNavigate('client-signup')}
                                className="rounded-2xl px-8 text-primary-600 hover:text-primary-700 shadow-xl"
                            >
                                Get Started
                            </Button>
                            <Button
                                size="lg"
                                variant="accent"
                                onClick={() => onNavigate('caregiver-signup')}
                                className="rounded-2xl px-8 shadow-xl"
                            >
                                Join as Caregiver
                            </Button>
                        </div>
                        <p className="text-primary-100 text-sm mt-6">
                            Cancel anytime • Clear pricing
                        </p>
                    </div>
                </section>

                {/* Footer */}
                <footer className="bg-slate-900 text-slate-300 py-12">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
                        <p className="text-sm">
                            © 2024 Evia. All rights reserved. • <button onClick={() => onNavigate('landing')} className="hover:text-white transition-colors">Privacy Policy</button> • <button onClick={() => onNavigate('landing')} className="hover:text-white transition-colors">Terms of Service</button>
                        </p>
                    </div>
                </footer>
            </div>
        </>
    );
};
