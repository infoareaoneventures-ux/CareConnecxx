import React, { useState } from 'react';
import { Activity, Search, Users, Briefcase, Globe, ChevronRight, LifeBuoy, BookOpen } from 'lucide-react';
import { ViewType } from '../types';
import { Footer } from './landing/Footer';
import { LoginModal } from './landing/LoginModal';
import { Button } from './ui/Button';
import { SEO } from './SEO';

interface HelpCenterProps {
  onNavigate: (view: ViewType) => void;
}

const categories = [
  {
    id: 'help-families' as ViewType,
    icon: <Users className="w-8 h-8 text-primary-600" />,
    bg: 'bg-primary-50',
    border: 'border-primary-100',
    title: 'Families',
    desc: 'Find caregivers, manage bookings, handle payments, and keep your loved ones safe.',
    articles: ['Finding & Hiring Caregivers', 'Payments & Billing', 'Trust & Safety', 'Account Settings'],
  },
  {
    id: 'help-caregivers' as ViewType,
    icon: <Briefcase className="w-8 h-8 text-accent-500" />,
    bg: 'bg-orange-50',
    border: 'border-orange-100',
    title: 'Caregivers',
    desc: 'Set up your profile, find jobs, manage your schedule, and get paid on time.',
    articles: ['Getting Started', 'Job Board & Applications', 'Managing Your Schedule', 'Payouts & Earnings'],
  },
  {
    id: 'help-general' as ViewType,
    icon: <Globe className="w-8 h-8 text-teal-600" />,
    bg: 'bg-teal-50',
    border: 'border-teal-100',
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
  { label: "What is CareConnex's privacy policy?", view: 'help-general' as ViewType },
  { label: 'How do I cancel or reschedule a booking?', view: 'help-families' as ViewType },
];

export const HelpCenter: React.FC<HelpCenterProps> = ({ onNavigate }) => {
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <SEO title="Help Center | CareConnex" description="Find answers about using CareConnex — for families, caregivers, and general platform questions." keywords="help, support, CareConnex, FAQ" />
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-20">
            <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
              <div className="bg-primary-600 p-2 rounded-xl shadow-lg shadow-primary-200/50"><Activity className="text-white w-6 h-6" /></div>
              <span className="text-2xl font-bold text-slate-900 tracking-tight">CareConnex</span>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={() => setIsLoginModalOpen(true)} className="text-slate-600 hover:text-primary-600 font-medium">Log In</button>
              <Button onClick={() => onNavigate('client-signup')}>Get Started</Button>
            </div>
          </div>
        </div>
      </header>
      <main className="flex-grow">
        <section className="bg-gradient-to-br from-primary-700 via-primary-600 to-teal-600 text-white py-20 md:py-28">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <div className="inline-flex items-center gap-2 bg-white/10 border border-white/20 rounded-full px-4 py-1.5 text-sm font-medium mb-6">
              <LifeBuoy className="w-4 h-4" /> CareConnex Help Center
            </div>
            <h1 className="text-4xl md:text-5xl font-bold mb-6 tracking-tight">How can we help you?</h1>
            <p className="text-lg text-primary-100 mb-8">Browse articles for families, caregivers, and general platform questions.</p>
            <div className="relative max-w-xl mx-auto">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input type="text" placeholder="Search for help articles…" className="w-full pl-12 pr-4 py-4 rounded-xl text-slate-900 text-base border-0 shadow-xl outline-none" readOnly />
            </div>
          </div>
        </section>
        <section className="max-w-6xl mx-auto px-4 py-16 md:py-24">
          <div className="grid md:grid-cols-3 gap-8">
            {categories.map(cat => (
              <button key={cat.id} onClick={() => onNavigate(cat.id)} className={`group text-left p-8 rounded-3xl border ${cat.bg} ${cat.border} hover:shadow-lg transition-all duration-200`}>
                <div className="mb-5">{cat.icon}</div>
                <h2 className="text-2xl font-bold text-slate-900 mb-3 group-hover:text-primary-700 transition-colors">{cat.title}</h2>
                <p className="text-slate-600 leading-relaxed mb-6">{cat.desc}</p>
                <ul className="space-y-2">
                  {cat.articles.map(a => (
                    <li key={a} className="flex items-center gap-2 text-sm text-slate-500">
                      <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />{a}
                    </li>
                  ))}
                </ul>
                <span className="inline-flex items-center gap-1 mt-6 text-primary-600 font-semibold text-sm group-hover:gap-2 transition-all">Browse {cat.title} articles <ChevronRight className="w-4 h-4" /></span>
              </button>
            ))}
          </div>
        </section>
        <section className="bg-white border-t border-slate-100 py-16">
          <div className="max-w-4xl mx-auto px-4">
            <h2 className="text-2xl font-bold text-slate-900 mb-8">Popular articles</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {popularArticles.map(art => (
                <button key={art.label} onClick={() => onNavigate(art.view)} className="flex items-center gap-3 text-left px-5 py-4 rounded-xl border border-slate-200 hover:border-primary-300 hover:bg-primary-50 transition-all group">
                  <BookOpen className="w-5 h-5 text-primary-500 flex-shrink-0" />
                  <span className="text-slate-700 group-hover:text-primary-700 font-medium text-sm">{art.label}</span>
                  <ChevronRight className="w-4 h-4 text-slate-300 ml-auto group-hover:text-primary-500 transition-colors" />
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className="py-20 bg-primary-50 border-t border-primary-100">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <h2 className="text-3xl font-bold text-slate-900 mb-4">Still need help?</h2>
            <p className="text-slate-600 mb-8">Our support team is available 7 days a week.</p>
            <Button size="lg" onClick={() => { window.location.href = 'mailto:support@careconnex.com'; }}>Contact Support</Button>
          </div>
        </section>
      </main>
      <Footer onNavigate={onNavigate} />
      {isLoginModalOpen && <LoginModal onNavigate={onNavigate} onClose={() => setIsLoginModalOpen(false)} />}
    </div>
  );
};
