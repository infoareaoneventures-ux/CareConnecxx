import React, { useState } from 'react';
import { Activity, Search, Users, Briefcase, Globe, ChevronRight, LifeBuoy, BookOpen } from 'lucide-react';
import { ViewType } from '../types';
import { Footer } from './landing/Footer';
import { Button } from './ui/Button';
import { SEO } from './SEO';

interface HelpCenterProps {
  onNavigate: (view: ViewType) => void;
}

const categories = [
  {
    id: 'help-families' as ViewType,
    icon: <Users className="w-7 h-7 text-ink-900" />,
    bg: 'bg-white',
    border: 'hairline',
    title: 'Families',
    desc: 'Find caregivers, manage bookings, handle payments, and keep your loved ones safe.',
    articles: ['Finding & Hiring Caregivers', 'Payments & Billing', 'Trust & Safety', 'Account Settings'],
  },
  {
    id: 'help-caregivers' as ViewType,
    icon: <Briefcase className="w-7 h-7 text-ink-900" />,
    bg: 'bg-white',
    border: 'hairline',
    title: 'Caregivers',
    desc: 'Set up your profile, find jobs, manage your schedule, and get paid on time.',
    articles: ['Getting Started', 'Job Board & Applications', 'Managing Your Schedule', 'Payouts & Earnings'],
  },
  {
    id: 'help-general' as ViewType,
    icon: <Globe className="w-7 h-7 text-ink-900" />,
    bg: 'bg-white',
    border: 'hairline',
    title: 'General',
    desc: 'Platform policies, privacy info, technical support, and community guidelines.',
    articles: ['Privacy & Data', 'Terms of Service', 'Technical Support', 'Community Guidelines'],
  },
];

const popularArticles = [
  { label: 'How do background checks work?', view: 'help-families' as ViewType },
  { label: 'How do I get paid as a caregiver?', view: 'help-caregivers' as ViewType },
  { label: 'How does AI matching work?', view: 'help-families' as ViewType },
  { label: 'How do I set up my caregiver profile?', view: 'help-caregivers' as ViewType },
  { label: "What is Evia's privacy policy?", view: 'help-general' as ViewType },
  { label: 'How do I cancel or reschedule a booking?', view: 'help-families' as ViewType },
];

export const HelpCenter: React.FC<HelpCenterProps> = ({ onNavigate }) => {
  return (
    <div className="min-h-screen bg-paper-50 flex flex-col font-sans">
      <SEO title="Help Center | Evia" description="Find answers about using Evia — for families, caregivers, and general platform questions." keywords="help, support, Evia, FAQ" />
      <header className="sticky top-0 z-50 bg-paper-50/95 backdrop-blur-sm border-b hairline">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-20">
            <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
              <div className="bg-ink-900 p-2 rounded-xl"><Activity className="text-white w-6 h-6" /></div>
              <span className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia</span>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={() => onNavigate('login')} className="text-ink-600 hover:text-ink-900 font-medium">Log In</button>
              <Button onClick={() => onNavigate('client-signup')}>Get Started</Button>
            </div>
          </div>
        </div>
      </header>
      <main className="flex-grow">
        <section className="bg-paper-50 py-20 md:py-28">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <div className="inline-flex items-center gap-2 bg-paper-100 border hairline text-ink-600 rounded-full px-4 py-1.5 text-sm font-medium mb-6">
              <LifeBuoy className="w-4 h-4" /> Evia Help Center
            </div>
            <h1 className="text-4xl md:text-5xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-6">How can we help you?</h1>
            <p className="text-lg text-ink-600 mb-8">Browse articles for families, caregivers, and general platform questions.</p>
            <div className="relative max-w-xl mx-auto">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-400" />
              <input type="text" placeholder="Search for help articles…" className="w-full pl-12 pr-4 py-4 rounded-full bg-white text-ink-900 text-base border hairline shadow-sm outline-none" readOnly />
            </div>
          </div>
        </section>
        <section className="max-w-6xl mx-auto px-4 py-16 md:py-24">
          <div className="grid md:grid-cols-3 gap-8">
            {categories.map(cat => (
              <button key={cat.id} onClick={() => onNavigate(cat.id)} className={`group text-left p-8 rounded-3xl border ${cat.bg} ${cat.border} shadow-sm hover:shadow-md transition-all duration-200`}>
                <div className="mb-5 inline-flex p-3 bg-paper-100 rounded-2xl">{cat.icon}</div>
                <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-3">{cat.title}</h2>
                <p className="text-ink-600 leading-relaxed mb-6">{cat.desc}</p>
                <ul className="space-y-2">
                  {cat.articles.map(a => (
                    <li key={a} className="flex items-center gap-2 text-sm text-ink-600">
                      <ChevronRight className="w-4 h-4 text-ink-400 flex-shrink-0" />{a}
                    </li>
                  ))}
                </ul>
                <span className="inline-flex items-center gap-1 mt-6 text-ink-600 group-hover:text-ink-900 font-medium text-sm group-hover:gap-2 transition-all">Browse {cat.title} articles <ChevronRight className="w-4 h-4" /></span>
              </button>
            ))}
          </div>
        </section>
        <section className="bg-paper-100 border-t hairline py-16">
          <div className="max-w-4xl mx-auto px-4">
            <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-8">Popular articles</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {popularArticles.map(art => (
                <button key={art.label} onClick={() => onNavigate(art.view)} className="flex items-center gap-3 text-left px-5 py-4 rounded-xl bg-white border hairline hover:shadow-sm transition-all group">
                  <BookOpen className="w-5 h-5 text-ink-400 flex-shrink-0" />
                  <span className="text-ink-600 group-hover:text-ink-900 font-medium text-sm">{art.label}</span>
                  <ChevronRight className="w-4 h-4 text-ink-400 ml-auto group-hover:text-ink-900 transition-colors" />
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className="py-20 bg-paper-50 border-t hairline">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <h2 className="text-3xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-4">Still need help?</h2>
            <p className="text-ink-600 mb-8">Our support team is available 7 days a week.</p>
            <Button size="lg" onClick={() => { window.location.href = 'mailto:support@eviacares.com'; }}>Contact Support</Button>
          </div>
        </section>
      </main>
      <Footer onNavigate={onNavigate} />
    </div>
  );
};
