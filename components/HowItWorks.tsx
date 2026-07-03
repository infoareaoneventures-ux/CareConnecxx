import React, { useState } from 'react';
import { ViewType } from '../types';
import { 
  ArrowLeft, Search, MessageSquare, Heart, ShieldCheck, DollarSign, 
  Calendar, Activity, X, Users, ChevronRight, MessageCircle, Phone,
  CheckCircle, MapPin, Clock, Star, ChevronDown, Zap, Lock
} from 'lucide-react';
import { Button } from './ui/Button';
import { SEO } from './SEO';
import { LegalDocs } from './LegalDocs';

interface HowItWorksProps {
   onNavigate: (view: ViewType) => void;
}

export const HowItWorks: React.FC<HowItWorksProps> = ({ onNavigate }) => {
   const [legalModal, setLegalModal] = useState<'privacy' | 'terms' | null>(null);
   const [activeFaq, setActiveFaq] = useState<number | null>(null);
   const [activeTab, setActiveTab] = useState<'families' | 'caregivers'>('families');

   const familySteps = [
      {
         step: "01",
         icon: <Search className="w-6 h-6" />,
         title: "Tell Us What You Need",
         desc: "Sign up and tell us about your loved one's needs, schedule, and preferences. We'll match you with verified caregivers in your area.",
         highlight: "Takes 2 minutes",
         color: "teal"
      },
      {
         step: "02",
         icon: <Search className="w-6 h-6" />,
         title: "Get Matched Instantly",
         desc: "Our AI analyzes your needs and matches you with verified caregivers in Santa Clara County. View profiles, rates, experience, and reviews. All caregivers are background-checked and insured.",
         highlight: "Smart AI matching",
         color: "blue"
      },
      {
         step: "03",
         icon: <Calendar className="w-6 h-6" />,
         title: "Interview & Hire",
         desc: "Schedule video interviews with your top choices. Ask questions, discuss care plans, and find the perfect fit. No pressure, no obligation until you're ready.",
         highlight: "You decide",
         color: "blue"
      },
      {
         step: "04",
         icon: <ShieldCheck className="w-6 h-6" />,
         title: "Book with Confidence",
         desc: "Secure payments via Stripe, GPS time tracking, and 24/7 support included. Start care and get peace of mind.",
         highlight: "Fully supported",
         color: "green"
      }
   ];

   const caregiverSteps = [
      {
         step: "01",
         icon: <Users className="w-6 h-6" />,
         title: "Create Your Profile",
         desc: "Sign up for free and build your professional profile. Showcase your experience, certifications, availability, and special skills. Set your own hourly rate.",
         highlight: "Free to join",
         color: "orange"
      },
      {
         step: "02",
         icon: <ShieldCheck className="w-6 h-6" />,
         title: "Get Verified",
         desc: "Complete our background check through Checkr. Verified caregivers get priority placement and 3x more job offers. We handle the verification cost.",
         highlight: "Stand out",
         color: "blue"
      },
      {
         step: "03",
         icon: <Star className="w-6 h-6" />,
         title: "Accept Jobs You Want",
         desc: "Browse local care opportunities that match your skills and schedule. No forced assignments - you choose the families you want to work with.",
         highlight: "Flexible work",
         color: "blue"
      },
      {
         step: "04",
         icon: <DollarSign className="w-6 h-6" />,
         title: "Get Paid Instantly",
         desc: "Clock in/out with GPS verification. Funds transfer to your bank automatically after each shift. Keep 100% of your rate - families pay the platform fee.",
         highlight: "Fast payment",
         color: "green"
      }
   ];

   const faqs = [
      {
         q: "How much does it cost?",
         a: "Families pay $29.95/month for unlimited access to the platform, plus the caregiver's hourly rate ($22-35/hour). There are no hidden fees, no placement fees, and no long-term contracts. Caregivers join for free and keep 100% of their hourly rate."
      },
      {
         q: "How is this different from a traditional agency?",
         a: "Traditional agencies charge $35-50/hour and keep 40-50% as their markup. With Evia, you pay caregivers directly at market rates ($22-35/hour) plus a flat monthly fee. You get more control, better transparency, and caregivers earn more."
      },
      {
         q: "Are the caregivers really verified?",
         a: "Yes. Every caregiver undergoes a comprehensive background check through Checkr, including criminal history, sex offender registry, and driving records. We also verify certifications."
      },
      {
         q: "What areas do you serve?",
         a: "We currently serve Santa Clara County including San Jose, Santa Clara, Sunnyvale, Mountain View, Palo Alto, Cupertino, Los Gatos, Campbell, Milpitas, and surrounding areas. We're expanding to more locations soon."
      },
      {
         q: "What if I don't like my caregiver?",
         a: "You can switch caregivers anytime at no extra cost. We encourage families to interview multiple candidates before hiring. If a caregiver isn't the right fit, browse for a new match in your dashboard."
      },
      {
         q: "How do payments work?",
         a: "Families pay caregivers directly via secure Stripe integration. Caregivers clock in/out with GPS verification. Payment is processed automatically after each shift. Families receive invoices, caregivers get paid fast."
      }
   ];

   const features = [
      { icon: <ShieldCheck className="w-5 h-5" />, text: "Background checked" },
      { icon: <Clock className="w-5 h-5" />, text: "GPS time tracking" },
      { icon: <Zap className="w-5 h-5" />, text: "Instant matching" }
   ];

   return (
      <div id="how-it-works" className="min-h-screen bg-white">
         <SEO
            title="How Evia Works - Simple 4-Step Process"
            description="Find verified caregivers in Santa Clara County in 4 simple steps. AI-powered matching and background checks included."
            keywords="how it works, find caregivers, hire caregivers, senior care process, caregiver matching, Santa Clara County"
            canonicalUrl="https://careconnex-d4c8b.web.app/how-it-works"
         />

         {/* Navigation Header */}
         <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b hairline">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
               <div className="flex justify-between items-center h-20">
                  <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
                     <div className="p-1">
                        <Activity className="text-ink-900 w-5 h-5" strokeWidth={2.5} />
                     </div>
                     <span className="font-display text-[22px] font-semibold text-ink-900 tracking-tight">Evia</span>
                  </div>

                  <nav className="hidden md:flex items-center space-x-8">
                     <button onClick={() => onNavigate('client-signup')} className="text-ink-600 hover:text-primary-600 font-medium transition-colors">Find Care</button>
                     <button onClick={() => onNavigate('caregiver-signup')} className="text-ink-600 hover:text-accent-500 font-medium transition-colors">Find Jobs</button>
                  </nav>

                  <div className="flex items-center space-x-4">
                     <button onClick={() => onNavigate('login')} className="hidden md:block text-ink-600 hover:text-primary-600 font-medium">Log In</button>
                     <Button onClick={() => onNavigate('client-signup')}>Get Started</Button>
                  </div>
               </div>
            </div>
         </header>

         <main>
            {/* Hero Section */}
            <section className="relative overflow-hidden bg-paper-50 py-20 lg:py-28">
               <div className="absolute inset-0 overflow-hidden">
                  <div className="absolute top-0 right-0 w-1/2 h-full bg-gradient-to-l from-primary-500/10 to-transparent"></div>
                  <div className="absolute bottom-0 left-0 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl"></div>
               </div>
               
               <div className="relative max-w-4xl mx-auto px-4 text-center">
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-paper-100 border hairline mb-8">
                     <MapPin className="w-4 h-4 text-ink-600" />
                     <span className="text-sm font-medium">Now Serving Santa Clara County</span>
                  </div>
                  
                  <h1 className="font-display text-4xl md:text-6xl font-semibold tracking-[-0.02em] mb-6 leading-tight">
                     Finding care just got <span className="text-ink-400">simple.</span>
                  </h1>
                  <p className="text-xl text-ink-600 max-w-2xl mx-auto mb-10 leading-relaxed">
                     No agencies. No markups. No endless phone calls. Just verified, local caregivers ready to help your family.
                  </p>

                  {/* Feature Pills */}
                  <div className="flex flex-wrap justify-center gap-3 mb-10">
                     {features.map((feature, i) => (
                        <div key={i} className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border hairline">
                           <span className="text-ink-600">{feature.icon}</span>
                           <span className="text-sm font-medium">{feature.text}</span>
                        </div>
                     ))}
                  </div>

                  <div className="flex justify-center">
                     <Button size="lg" onClick={() => onNavigate('client-signup')} className="shadow-xl shadow-primary-500/20">
                        Find a Caregiver
                     </Button>
                  </div>
               </div>
            </section>

            {/* Tab Switcher */}
            <section className="py-12 bg-paper-50 border-b hairline">
               <div className="max-w-3xl mx-auto px-4">
                  <div className="flex p-1 bg-white rounded-2xl shadow-sm border hairline">
                     <button
                        onClick={() => setActiveTab('families')}
                        className={`flex-1 py-3 px-6 rounded-xl font-semibold transition-all ${
                           activeTab === 'families' 
                              ? 'bg-ink-900 text-white shadow-lg' 
                              : 'text-ink-600 hover:text-ink-900'
                        }`}
                     >
                        For Families
                     </button>
                     <button
                        onClick={() => setActiveTab('caregivers')}
                        className={`flex-1 py-3 px-6 rounded-xl font-semibold transition-all ${
                           activeTab === 'caregivers' 
                              ? 'bg-ink-900 text-white shadow-lg' 
                              : 'text-ink-600 hover:text-ink-900'
                        }`}
                     >
                        For Caregivers
                     </button>
                  </div>
               </div>
            </section>

            {/* Steps Section */}
            <section className="py-20 lg:py-28">
               <div className="max-w-5xl mx-auto px-4">
                  <div className="text-center mb-16">
                     <h2 className="font-display text-3xl md:text-4xl font-semibold tracking-[-0.02em] text-ink-900 mb-4">
                        {activeTab === 'families' ? 'Find care in 4 simple steps' : 'Start earning in 4 simple steps'}
                     </h2>
                     <p className="text-lg text-ink-600 max-w-2xl mx-auto">
                        {activeTab === 'families' 
                           ? 'From search to care, we handle the hard parts so you can focus on your loved one.'
                           : 'Join thousands of caregivers earning more with flexible schedules and instant payments.'
                        }
                     </p>
                  </div>

                  <div className="space-y-8">
                     {(activeTab === 'families' ? familySteps : caregiverSteps).map((step, i) => (
                        <div 
                           key={i} 
                           className={`relative flex flex-col md:flex-row gap-6 md:gap-10 p-8 rounded-3xl border transition-all hover:shadow-lg ${
                              activeTab === 'families' 
                                 ? 'bg-white hairline hover:border-primary-200' 
                                 : 'bg-white hairline hover:border-accent-200'
                           }`}
                        >
                           {/* Step Number */}
                           <div className="flex-shrink-0">
                              <div className={`w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold ${
                                 activeTab === 'families' ? 'bg-primary-100 text-primary-700' : 'bg-accent-100 text-accent-700'
                              }`}>
                                 {step.step}
                              </div>
                           </div>

                           {/* Content */}
                           <div className="flex-grow">
                              <div className="flex flex-wrap items-center gap-3 mb-3">
                                 <h3 className="text-xl font-bold text-ink-900">{step.title}</h3>
                                 <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                                    activeTab === 'families' 
                                       ? 'bg-primary-50 text-primary-700' 
                                       : 'bg-accent-50 text-accent-700'
                                 }`}>
                                    {step.highlight}
                                 </span>
                              </div>
                              <p className="text-ink-600 leading-relaxed">{step.desc}</p>
                           </div>

                           {/* Icon */}
                           <div className={`flex-shrink-0 w-14 h-14 rounded-2xl flex items-center justify-center ${
                              activeTab === 'families' ? 'bg-ink-900 text-white' : 'bg-ink-900 text-white'
                           }`}>
                              {step.icon}
                           </div>
                        </div>
                     ))}
                  </div>

                  {/* CTA */}
                  <div className="mt-12 text-center">
                     <Button 
                        size="lg" 
                        variant={activeTab === 'families' ? 'primary' : 'accent'}
                        onClick={() => onNavigate(activeTab === 'families' ? 'client-signup' : 'caregiver-signup')}
                     >
                        {activeTab === 'families' ? 'Get Started - Find Care' : 'Join as a Caregiver'}
                     </Button>
                     <p className="mt-4 text-sm text-ink-600">
                        {activeTab === 'families' 
                           ? 'Free to browse. $29.95/month when you hire.' 
                           : 'Free to join. Keep 100% of your rate.'
                        }
                     </p>
                  </div>
               </div>
            </section>

            {/* Pricing Transparency */}
            <section className="py-20 bg-white">
               <div className="max-w-4xl mx-auto px-4 text-center">
                  <h2 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink-900 mb-4">Simple, transparent pricing</h2>
                  <p className="text-ink-600 mb-12">No hidden fees. No surprises. Just straightforward care.</p>

                  <div className="grid md:grid-cols-2 gap-8">
                     {/* Family Pricing */}
                     <div className="bg-paper-50 rounded-3xl p-8 border hairline">
                        <div className="text-primary-600 font-semibold mb-2">For Families</div>
                        <div className="flex items-baseline justify-center gap-2 mb-4">
                           <span className="font-display text-5xl font-semibold tracking-[-0.02em] text-ink-900">$29.95</span>
                           <span className="text-ink-600">/month</span>
                        </div>
                        <p className="text-ink-600 mb-6">Plus caregiver hourly rate ($22-35/hour)</p>
                        <ul className="text-left space-y-3 mb-8">
                           {[
                              'Unlimited caregiver matches',
                              'Background checks included',
                              'GPS time tracking',
                              '24/7 customer support',
                              'Cancel anytime'
                           ].map((item, i) => (
                              <li key={i} className="flex items-center gap-3 text-ink-600">
                                 <CheckCircle className="w-5 h-5 text-primary-500 flex-shrink-0" />
                                 {item}
                              </li>
                           ))}
                        </ul>
                        <Button fullWidth onClick={() => onNavigate('client-signup')}>
                           Find Caregivers
                        </Button>
                     </div>

                     {/* Caregiver Pricing */}
                     <div className="bg-accent-50 rounded-3xl p-8 border border-accent-100">
                        <div className="text-accent-600 font-semibold mb-2">For Caregivers</div>
                        <div className="flex items-baseline justify-center gap-2 mb-4">
                           <span className="font-display text-5xl font-semibold tracking-[-0.02em] text-ink-900">Free</span>
                        </div>
                        <p className="text-ink-600 mb-6">Keep 100% of your hourly rate</p>
                        <ul className="text-left space-y-3 mb-8">
                           {[
                              'Free profile & job access',
                              'Instant job notifications',
                              'Secure payments via Stripe',
                              'Direct client relationships',
                              'Build your reputation'
                           ].map((item, i) => (
                              <li key={i} className="flex items-center gap-3 text-ink-600">
                                 <CheckCircle className="w-5 h-5 text-accent-500 flex-shrink-0" />
                                 {item}
                              </li>
                           ))}
                        </ul>
                        <Button variant="accent" fullWidth onClick={() => onNavigate('caregiver-signup')}>
                           Join as Caregiver
                        </Button>
                     </div>
                  </div>
               </div>
            </section>

            {/* FAQ Section */}
            <section className="py-20 bg-paper-50">
               <div className="max-w-3xl mx-auto px-4">
                  <div className="text-center mb-12">
                     <h2 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink-900 mb-4">Frequently asked questions</h2>
                     <p className="text-ink-600">Everything you need to know about Evia.</p>
                  </div>

                  <div className="space-y-4">
                     {faqs.map((faq, i) => (
                        <div 
                           key={i} 
                           className="bg-white rounded-2xl border hairline overflow-hidden"
                        >
                           <button
                              onClick={() => setActiveFaq(activeFaq === i ? null : i)}
                              className="w-full flex items-center justify-between p-6 text-left hover:bg-paper-100 transition-colors"
                           >
                              <span className="font-semibold text-ink-900 pr-4">{faq.q}</span>
                              <ChevronDown className={`w-5 h-5 text-ink-400 flex-shrink-0 transition-transform ${activeFaq === i ? 'rotate-180' : ''}`} />
                           </button>
                           {activeFaq === i && (
                              <div className="px-6 pb-6">
                                 <p className="text-ink-600 leading-relaxed">{faq.a}</p>
                              </div>
                           )}
                        </div>
                     ))}
                  </div>

                  <div className="mt-10 text-center">
                     <p className="text-ink-600 mb-4">Still have questions?</p>
                     <Button onClick={() => onNavigate('client-signup')} variant="outline">
                        Get Started
                     </Button>
                  </div>
               </div>
            </section>

            {/* Partner Logos */}
            <section className="py-16 bg-white border-y hairline">
               <div className="max-w-5xl mx-auto px-4">
                  <p className="text-center text-sm font-semibold text-ink-400 uppercase tracking-wider mb-8">
                     Trusted Partners & Integrations
                  </p>
                  <div className="flex flex-wrap justify-center items-center gap-8 md:gap-16">
                     {/* Stripe */}
                     <a 
                        href="https://stripe.com" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-ink-600 hover:text-ink-900 transition-colors"
                     >
                        <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center">
                           <span className="text-white font-bold text-sm">S</span>
                        </div>
                        <span className="text-xl font-bold">Stripe</span>
                     </a>
                     
                     {/* Checkr */}
                     <a 
                        href="https://checkr.com" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-ink-600 hover:text-ink-900 transition-colors"
                     >
                        <div className="w-8 h-8 bg-green-600 rounded flex items-center justify-center">
                           <CheckCircle className="w-5 h-5 text-white" />
                        </div>
                        <span className="text-xl font-bold">Checkr</span>
                     </a>
                     
                     {/* WhatsApp */}
                     <div className="flex items-center gap-2 text-ink-600">
                        <MessageCircle className="w-8 h-8 text-green-500" />
                        <span className="text-xl font-bold">WhatsApp</span>
                     </div>
                  </div>
                  <p className="text-center text-sm text-ink-600 mt-6">
                     Payments by Stripe • Background checks by Checkr
                  </p>
               </div>
            </section>

            {/* Agency Comparison Table */}
            <section className="py-20 bg-paper-50">
               <div className="max-w-4xl mx-auto px-4">
                  <div className="text-center mb-12">
                     <h2 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink-900 mb-4">Why families choose Evia</h2>
                     <p className="text-ink-600">See how we compare to traditional care agencies</p>
                  </div>

                  <div className="bg-white rounded-3xl shadow-xl overflow-hidden border hairline">
                     <div className="overflow-x-auto">
                        <table className="w-full">
                           <thead>
                              <tr className="bg-slate-900 text-white">
                                 <th className="py-4 px-6 text-left font-semibold">Feature</th>
                                 <th className="py-4 px-6 text-center font-semibold bg-primary-600">Evia</th>
                                 <th className="py-4 px-6 text-center font-semibold text-ink-400">Traditional Agency</th>
                              </tr>
                           </thead>
                           <tbody className="divide-y divide-slate-100">
                              <tr>
                                 <td className="py-4 px-6 font-medium text-ink-900">Hourly Rate</td>
                                 <td className="py-4 px-6 text-center bg-primary-50">
                                    <span className="font-bold text-primary-700">$22-35/hour</span>
                                 </td>
                                 <td className="py-4 px-6 text-center text-ink-600">$35-50/hour</td>
                              </tr>
                              <tr>
                                 <td className="py-4 px-6 font-medium text-ink-900">Agency Markup</td>
                                 <td className="py-4 px-6 text-center bg-primary-50">
                                    <span className="font-bold text-primary-700">None</span>
                                 </td>
                                 <td className="py-4 px-6 text-center text-ink-600">40-50%</td>
                              </tr>
                              <tr>
                                 <td className="py-4 px-6 font-medium text-ink-900">Contract</td>
                                 <td className="py-4 px-6 text-center bg-primary-50">
                                    <span className="font-bold text-primary-700">Cancel anytime</span>
                                 </td>
                                 <td className="py-4 px-6 text-center text-ink-600">6-12 months</td>
                              </tr>
                              <tr>
                                 <td className="py-4 px-6 font-medium text-ink-900">Background Checks</td>
                                 <td className="py-4 px-6 text-center bg-primary-50">
                                    <CheckCircle className="w-5 h-5 text-primary-600 mx-auto" />
                                    <span className="text-sm text-primary-700">Included</span>
                                 </td>
                                 <td className="py-4 px-6 text-center text-ink-600">Varies</td>
                              </tr>
                              <tr>
                                 <td className="py-4 px-6 font-medium text-ink-900">Caregiver Choice</td>
                                 <td className="py-4 px-6 text-center bg-primary-50">
                                    <span className="font-bold text-primary-700">You choose</span>
                                 </td>
                                 <td className="py-4 px-6 text-center text-ink-600">They assign</td>
                              </tr>
                              <tr>
                                 <td className="py-4 px-6 font-medium text-ink-900">Platform Fee</td>
                                 <td className="py-4 px-6 text-center bg-primary-50">
                                    <span className="font-bold text-primary-700">$29.95/month</span>
                                 </td>
                                 <td className="py-4 px-6 text-center text-ink-600">Hidden in markup</td>
                              </tr>
                           </tbody>
                        </table>
                     </div>
                  </div>

                  <div className="mt-8 text-center">
                     <p className="text-ink-600 mb-4">Average family savings: <span className="font-bold text-primary-600">$400-800/month</span></p>
                     <Button size="lg" onClick={() => onNavigate('client-signup')}>
                        Start Saving Today
                     </Button>
                  </div>
               </div>
            </section>

            {/* Service Area Map */}
            <section className="py-20 bg-white">
               <div className="max-w-5xl mx-auto px-4">
                  <div className="text-center mb-12">
                     <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-50 border border-primary-200 text-primary-700 text-sm font-semibold mb-4">
                        <MapPin className="w-4 h-4" />
                        Now Serving Santa Clara County
                     </div>
                     <h2 className="font-display text-3xl md:text-4xl font-semibold tracking-[-0.02em] text-ink-900 mb-4">
                        Care available across Santa Clara County
                     </h2>
                     <p className="text-ink-600 max-w-2xl mx-auto">
                        From San Jose to Palo Alto, we're bringing quality in-home care to families throughout the Bay Area.
                     </p>
                  </div>

                  <div className="grid md:grid-cols-2 gap-8 items-center">
                     {/* Map Visual */}
                     <div className="bg-white rounded-3xl p-8 border hairline">
                        <div className="aspect-square bg-white rounded-2xl shadow-lg p-6 flex items-center justify-center relative overflow-hidden">
                           {/* Stylized Map of Santa Clara County */}
                           <svg viewBox="0 0 400 400" className="w-full h-full">
                              {/* County outline - stylized */}
                              <path 
                                 d="M50 100 L150 50 L300 80 L350 200 L320 350 L200 380 L80 320 Z" 
                                 fill="#f0fdfa" 
                                 stroke="#14b8a6" 
                                 strokeWidth="3"
                              />
                              {/* City markers */}
                              <circle cx="200" cy="200" r="8" fill="#14b8a6" />
                              <text x="200" y="190" textAnchor="middle" className="text-xs font-semibold fill-slate-700">San Jose</text>
                              
                              <circle cx="280" cy="150" r="6" fill="#0ea5e9" />
                              <text x="280" y="140" textAnchor="middle" className="text-xs font-semibold fill-slate-700">Milpitas</text>
                              
                              <circle cx="320" cy="220" r="6" fill="#0ea5e9" />
                              <text x="320" y="235" textAnchor="middle" className="text-xs font-semibold fill-slate-700">San Jose</text>
                              
                              <circle cx="250" cy="280" r="6" fill="#0ea5e9" />
                              <text x="250" y="295" textAnchor="middle" className="text-xs font-semibold fill-slate-700">Los Gatos</text>
                              
                              <circle cx="150" cy="250" r="6" fill="#0ea5e9" />
                              <text x="150" y="265" textAnchor="middle" className="text-xs font-semibold fill-slate-700">Campbell</text>
                              
                              <circle cx="120" cy="150" r="6" fill="#0ea5e9" />
                              <text x="120" y="140" textAnchor="middle" className="text-xs font-semibold fill-slate-700">Santa Clara</text>
                              
                              <circle cx="180" cy="100" r="6" fill="#0ea5e9" />
                              <text x="180" y="90" textAnchor="middle" className="text-xs font-semibold fill-slate-700">Sunnyvale</text>
                              
                              <circle cx="260" cy="80" r="6" fill="#0ea5e9" />
                              <text x="260" y="70" textAnchor="middle" className="text-xs font-semibold fill-slate-700">Mountain View</text>
                              
                              <circle cx="330" cy="100" r="6" fill="#0ea5e9" />
                              <text x="330" y="90" textAnchor="middle" className="text-xs font-semibold fill-slate-700">Palo Alto</text>
                              
                              <circle cx="220" cy="150" r="6" fill="#0ea5e9" />
                              <text x="220" y="140" textAnchor="middle" className="text-xs font-semibold fill-slate-700">Cupertino</text>
                           </svg>
                           
                           {/* Legend */}
                           <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur-sm rounded-lg p-2 text-xs">
                              <div className="flex items-center gap-2">
                                 <div className="w-3 h-3 rounded-full bg-primary-500"></div>
                                 <span className="text-ink-600">Main Hub</span>
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                 <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                                 <span className="text-ink-600">Service Area</span>
                              </div>
                           </div>
                        </div>
                     </div>

                     {/* Cities List */}
                     <div className="space-y-6">
                        <div>
                           <h3 className="text-xl font-bold text-ink-900 mb-4">Cities We Serve</h3>
                           <div className="grid grid-cols-2 gap-3">
                              {[
                                 'San Jose',
                                 'Santa Clara',
                                 'Sunnyvale',
                                 'Mountain View',
                                 'Palo Alto',
                                 'Cupertino',
                                 'Los Gatos',
                                 'Campbell',
                                 'Milpitas',
                                 'Saratoga',
                                 'Los Altos',
                                 'Morgan Hill'
                              ].map((city) => (
                                 <div key={city} className="flex items-center gap-2 text-ink-600">
                                    <MapPin className="w-4 h-4 text-primary-500 flex-shrink-0" />
                                    <span>{city}</span>
                                 </div>
                              ))}
                           </div>
                        </div>

                        <div className="bg-primary-50 rounded-2xl p-6 border border-primary-100">
                           <h4 className="font-semibold text-primary-900 mb-2">Don't see your city?</h4>
                           <p className="text-primary-700 text-sm mb-4">
                              We're expanding throughout the Bay Area. Email <a href="mailto:hello@eviacares.com" className="font-semibold underline">hello@eviacares.com</a> to check availability in your neighborhood.
                           </p>
                        </div>
                     </div>
                  </div>
               </div>
            </section>

            {/* Trust & Safety */}
            <section className="py-20 bg-paper-100 border-t hairline">
               <div className="max-w-4xl mx-auto px-4 text-center">
                  <div className="inline-flex p-4 bg-paper-200 rounded-full mb-6">
                     <ShieldCheck className="w-8 h-8 text-ink-900" />
                  </div>
                  <h2 className="font-display text-3xl font-semibold tracking-[-0.02em] mb-6">Safety is our obsession.</h2>
                  <p className="text-ink-600 max-w-2xl mx-auto mb-12">
                     We know you're trusting us with your loved ones. Here's how we earn that trust every day.
                  </p>

                  <div className="grid md:grid-cols-2 gap-6 text-left">
                     {[
                        { title: "Identity Verification", desc: "Every caregiver verified via Stripe & Checkr background checks" },
                        { title: "Secure Payments", desc: "No cash exchanges. All payments tracked via Stripe" },
                        { title: "GPS Monitoring", desc: "Real-time check-ins ensure caregivers are on site when they clock in" },
                        { title: "Interview First", desc: "Meet your caregiver via video call before making any decisions" },
                        { title: "24/7 Support", desc: "Our team is always available for emergencies" }
                     ].map((item, i) => (
                        <div key={i} className="flex items-start gap-4 p-6 bg-slate-800 rounded-2xl border border-slate-700">
                           <CheckCircle className="w-6 h-6 text-primary-400 flex-shrink-0 mt-0.5" />
                           <div>
                              <h3 className="font-semibold mb-1">{item.title}</h3>
                              <p className="text-ink-400 text-sm">{item.desc}</p>
                           </div>
                        </div>
                     ))}
                  </div>
               </div>
            </section>

            {/* Final CTA */}
            <section className="py-20 bg-paper-100 border-t hairline">
               <div className="max-w-3xl mx-auto px-4 text-center">
                  <h2 className="font-display text-3xl md:text-4xl font-semibold tracking-[-0.02em] mb-6">Ready to find the perfect care?</h2>
                  <p className="text-xl text-ink-600 mb-10">
                     Join hundreds of families in Santa Clara County who trust Evia for their loved ones.
                  </p>
                  <div className="flex flex-col sm:flex-row justify-center gap-4">
                     <Button
                        size="lg"
                        className=""
                        onClick={() => onNavigate('client-signup')}
                     >
                        Get Started Today
                     </Button>
                  </div>
               </div>
            </section>

            {/* Footer */}
            <footer className="bg-paper-50 py-12 border-t hairline">
               <div className="max-w-4xl mx-auto px-4 text-center">
                  <div className="flex justify-center gap-6 mb-6">
                     <button onClick={() => onNavigate('client-signup')} className="text-ink-600 font-medium hover:text-ink-900">Sign up as Family</button>
                     <button onClick={() => onNavigate('caregiver-signup')} className="text-ink-600 font-medium hover:text-ink-900">Sign up as Caregiver</button>
                  </div>
                  <div className="flex gap-6 justify-center text-sm text-ink-400">
                     <button onClick={() => setLegalModal('privacy')} className="hover:text-ink-600">Privacy Policy</button>
                     <button onClick={() => setLegalModal('terms')} className="hover:text-ink-600">Terms of Service</button>
                  </div>
                  <p className="mt-8 text-sm text-ink-400">
                     © 2026 Evia. Serving Santa Clara County.
                  </p>
               </div>
            </footer>

            {legalModal && <LegalDocs type={legalModal} onClose={() => setLegalModal(null)} />}
         </main>
      </div>
   );
};
