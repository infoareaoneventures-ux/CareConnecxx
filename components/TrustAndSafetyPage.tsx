import React, { useState } from 'react';
import { ViewType } from '../types';
import { 
  ShieldCheck, HeartHandshake, CheckCircle, 
  MessageSquare, Users, Lock, Clock, Award, Star
} from 'lucide-react';
import { BloomMark } from './ui/BloomMark';
import { Button } from './ui/Button';
import { SEO } from './SEO';
import { Footer } from './landing/Footer';

interface TrustAndSafetyPageProps {
   onNavigate: (view: ViewType) => void;
}

export const TrustAndSafetyPage: React.FC<TrustAndSafetyPageProps> = ({ onNavigate }) => {

   const trustTools = [
      {
         icon: <HeartHandshake className="w-8 h-8 text-ink-900" />,
         title: "Community recommendations",
         desc: "See caregivers recommended by families from local community centers, senior support groups, and neighborhood networks."
      },
      {
         icon: <Users className="w-8 h-8 text-ink-900" />,
         title: "Repeat families",
         desc: "Every caregiver profile shows total bookings completed and how many families have booked them again. A caregiver with many repeat families is a strong sign of trust."
      },
      {
         icon: <Star className="w-8 h-8 text-ink-900" />,
         title: "Parent reviews",
         desc: "Read reviews from families who have hired the caregiver. Reviews can only be written after a completed job, so every review reflects a firsthand experience."
      }
   ];

   const badges = [
      {
         icon: <ShieldCheck className="w-6 h-6 text-ink-900" />,
         title: "Annual background checks",
         desc: "Every caregiver must complete a background check. Background checks are processed by Checkr annually."
      },
      {
         icon: <Clock className="w-6 h-6 text-ink-900" />,
         title: "Responds quickly to new families",
         desc: "Caregivers with this badge typically respond in 24 hours or less to new families."
      },
      {
         icon: <Award className="w-6 h-6 text-ink-900" />,
         title: "Reliability",
         desc: "Caregivers with this badge completed 90 to 100% of their recent jobs."
      }
   ];

   const privacyFeatures = [
      {
         icon: <MessageSquare className="w-6 h-6 text-white" />,
         title: "Safe messaging",
         desc: "Your contact information is only shared with a caregiver after a booking is confirmed, keeping your personal details private until you are ready."
      },
      {
         icon: <CheckCircle className="w-6 h-6 text-white" />,
         title: "Member authenticity",
         desc: "All families go through an authentication process before they can book caregivers."
      },
      {
         icon: <Lock className="w-6 h-6 text-white" />,
         title: "Payment protection",
         desc: "All payments are processed securely through our payment partners. Your financial information is never shared with caregivers."
      },
      {
         icon: <ShieldCheck className="w-6 h-6 text-white" />,
         title: "Industry-respected trust and safety partners",
         desc: "Evia partners with Checkr for background checks and Stripe for payment processing, two of the most trusted names in their fields."
      }
   ];

   const supportFeatures = [
      {
         title: "Here when you need us",
         desc: "Text Evia any time, day or night, or message our team from your account — for booking questions, safety concerns, or anything else you need."
      },
      {
         title: "Upgraded background checks",
         desc: "Want additional peace of mind? Families can request an upgraded background check or a driving record check package for a caregiver. Contact us for options."
      },
      {
         title: "Booking support",
         desc: "We provide support for payment, reliability and member concerns for every booking scheduled through Evia."
      }
   ];

   return (
      <div className="min-h-screen bg-paper-50 font-sans">
         <SEO
            title="Trust & Safety | Evia"
            description="Your family's safety is our top priority. Every caregiver on Evia is background checked annually. Learn more about our Trust and Safety tools."
            keywords="trust, safety, background checks, secure payments, safe messaging, Evia"
         />

         {/* Navigation Header */}
         <header className="sticky top-0 z-50 bg-paper-50/95 backdrop-blur-sm border-b hairline">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
               <div className="flex justify-between items-center h-20">
                  <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
                     <div className="bg-ink-900 p-2 rounded-xl">
                        <BloomMark className="text-white w-6 h-6" />
                     </div>
                     <span className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia</span>
                  </div>

                  <nav className="hidden md:flex items-center space-x-8">
                     <button onClick={() => onNavigate('client-signup')} className="text-ink-600 hover:text-ink-900 font-medium transition-colors">Find Care</button>
                     <button onClick={() => onNavigate('caregiver-signup')} className="text-ink-600 hover:text-ink-900 font-medium transition-colors">Find Jobs</button>
                  </nav>

                  <div className="flex items-center space-x-4">
                     <button onClick={() => onNavigate('login')} className="hidden md:block text-ink-600 hover:text-ink-900 font-medium">Log In</button>
                     <Button onClick={() => onNavigate('client-signup')}>Get Started</Button>
                  </div>
               </div>
            </div>
         </header>

         <main>
            {/* Hero Section */}
            <section className="relative overflow-hidden bg-paper-50 py-24 lg:py-32">
               <div className="relative max-w-4xl mx-auto px-4 text-center">
                  <div className="inline-flex items-center justify-center p-4 bg-paper-100 rounded-full mb-8 border hairline">
                     <ShieldCheck className="w-12 h-12 text-ink-900" />
                  </div>
                  <h1 className="text-4xl md:text-6xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-6 leading-tight">
                     Your family's safety is our top priority.
                  </h1>
                  <p className="text-xl text-ink-600 max-w-2xl mx-auto leading-relaxed">
                     Every caregiver on Evia is background checked annually. Each caregiver profile is individually reviewed by our Trust and Safety team. Our aim is to provide members with transparency and information to make informed decisions.
                  </p>
               </div>
            </section>

            {/* Trust Tools Section */}
            <section className="py-20 bg-paper-100 border-b hairline">
               <div className="max-w-6xl mx-auto px-4">
                  <div className="text-center mb-16">
                     <h2 className="text-3xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-6">Tools to find care you can trust</h2>
                     <p className="text-lg text-ink-600 max-w-2xl mx-auto">
                        From community recommendations and parent reviews to annual background checks and responsive support, Evia gives you the tools to find senior care you can trust.
                     </p>
                  </div>

                  <div className="grid md:grid-cols-3 gap-8">
                     {trustTools.map((tool, idx) => (
                        <div key={idx} className="bg-white p-8 rounded-3xl shadow-sm border hairline hover:shadow-md transition-shadow">
                           <div className="mb-6 p-4 bg-paper-100 rounded-2xl inline-block">
                              {tool.icon}
                           </div>
                           <h3 className="text-xl font-semibold text-ink-900 mb-4">{tool.title}</h3>
                           <p className="text-ink-600 leading-relaxed">{tool.desc}</p>
                        </div>
                     ))}
                  </div>
               </div>
            </section>

            {/* Badges Section */}
            <section className="py-20 bg-paper-50">
               <div className="max-w-6xl mx-auto px-4">
                  <div className="grid md:grid-cols-2 gap-16 items-center">
                     <div>
                        <h2 className="text-3xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-8">Caregiver badges of trust</h2>
                        <div className="space-y-8">
                           {badges.map((badge, idx) => (
                              <div key={idx} className="flex items-start gap-4">
                                 <div className="flex-shrink-0 mt-1 p-3 bg-paper-100 rounded-xl border hairline">
                                    {badge.icon}
                                 </div>
                                 <div>
                                    <h3 className="text-xl font-semibold text-ink-900 mb-2">{badge.title}</h3>
                                    <p className="text-ink-600">{badge.desc}</p>
                                 </div>
                              </div>
                           ))}
                        </div>
                     </div>
                     <div className="bg-paper-100 p-8 rounded-3xl border hairline relative">
                        <div className="bg-white p-6 rounded-2xl shadow-sm border hairline flex items-center gap-6 mb-4">
                           <div className="w-16 h-16 rounded-full bg-paper-200 flex-shrink-0 relative overflow-hidden">
                              <img src="https://ui-avatars.com/api/?name=Sarah+M&background=random" alt="Caregiver avatar" className="w-full h-full object-cover" />
                              <div className="absolute bottom-0 right-0 bg-white p-0.5 rounded-full">
                                 <ShieldCheck className="w-4 h-4 text-green-600" />
                              </div>
                           </div>
                           <div>
                              <h4 className="font-semibold text-ink-900 text-lg">Sarah M.</h4>
                              <div className="flex items-center gap-2 text-sm text-ink-600 mt-1">
                                 <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                                 <span>5.0 (24 reviews)</span>
                                 <span className="text-ink-400">•</span>
                                 <span>15 repeat families</span>
                              </div>
                           </div>
                        </div>
                        <div className="bg-white p-4 rounded-xl shadow-sm border hairline flex items-center gap-3">
                           <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center flex-shrink-0">
                              <Award className="w-5 h-5 text-green-600" />
                           </div>
                           <div>
                              <p className="text-sm font-semibold text-ink-900">Highly Reliable</p>
                              <p className="text-xs text-ink-600">Completed 100% of recent jobs</p>
                           </div>
                        </div>
                     </div>
                  </div>
               </div>
            </section>

            {/* Privacy Section */}
            <section className="py-20 bg-ink-900 text-white">
               <div className="max-w-6xl mx-auto px-4">
                  <div className="text-center mb-16">
                     <h2 className="text-3xl font-display font-semibold tracking-[-0.02em] mb-6">How Evia protects your privacy</h2>
                     <p className="text-lg text-white/70 max-w-2xl mx-auto">
                        We use industry-leading security practices to keep your personal and financial information safe.
                     </p>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-8">
                     {privacyFeatures.map((feature, idx) => (
                        <div key={idx} className="bg-white/5 p-8 rounded-3xl border border-white/10">
                           <div className="flex items-center gap-4 mb-4">
                              <div className="p-3 bg-white/10 rounded-xl">
                                 {feature.icon}
                              </div>
                              <h3 className="text-xl font-semibold">{feature.title}</h3>
                           </div>
                           <p className="text-white/70 leading-relaxed">{feature.desc}</p>
                        </div>
                     ))}
                  </div>
               </div>
            </section>

            {/* Support Section */}
            <section className="py-20 bg-paper-50">
               <div className="max-w-4xl mx-auto px-4 text-center">
                  <h2 className="text-3xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-12">Support from our Trust & Safety teams</h2>

                  <div className="grid md:grid-cols-3 gap-8 text-left">
                     {supportFeatures.map((feature, idx) => (
                        <div key={idx} className="flex flex-col">
                           <h3 className="text-xl font-semibold text-ink-900 mb-3">{feature.title}</h3>
                           <p className="text-ink-600 leading-relaxed flex-grow">{feature.desc}</p>
                        </div>
                     ))}
                  </div>
               </div>
            </section>
            
            {/* CTA Section */}
            <section className="py-20 bg-paper-100 border-t hairline">
               <div className="max-w-3xl mx-auto px-4 text-center">
                  <h2 className="text-3xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-6">Ready to find a caregiver you can trust?</h2>
                  <div className="flex flex-col sm:flex-row justify-center gap-4">
                     <Button size="lg" onClick={() => onNavigate('client-signup')}>
                        Sign up free
                     </Button>
                     <Button size="lg" variant="secondary" onClick={() => onNavigate('how-it-works')}>
                        Learn how it works
                     </Button>
                  </div>
               </div>
            </section>

            <Footer onNavigate={onNavigate} />
         </main>
      </div>
   );
};
