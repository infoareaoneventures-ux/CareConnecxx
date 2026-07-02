import React, { useState } from 'react';
import { ViewType } from '../types';
import { Activity, Search, ChevronDown, ChevronUp, BookOpen, ShieldCheck, Calendar, CreditCard, Settings, ChevronRight } from 'lucide-react';
import { Button } from './ui/Button';
import { SEO } from './SEO';
import { Footer } from './landing/Footer';

interface FamilyFAQProps {
   onNavigate: (view: ViewType) => void;
}

export const FamilyFAQ: React.FC<FamilyFAQProps> = ({ onNavigate }) => {
   const [activeCategory, setActiveCategory] = useState<string>('getting-started');
   const [openFaq, setOpenFaq] = useState<string | null>(null);

   const toggleFaq = (id: string) => {
      setOpenFaq(openFaq === id ? null : id);
   };

   const categories = [
      { id: 'getting-started', title: 'Getting Started & Finding Care', icon: <BookOpen className="w-6 h-6" /> },
      { id: 'trust-safety', title: 'Trust & Safety', icon: <ShieldCheck className="w-6 h-6" /> },
      { id: 'bookings', title: 'Bookings & Care Management', icon: <Calendar className="w-6 h-6" /> },
      { id: 'payments', title: 'Payments & Subscriptions', icon: <CreditCard className="w-6 h-6" /> },
      { id: 'account', title: 'Account Settings', icon: <Settings className="w-6 h-6" /> },
   ];

   const faqs: Record<string, { id: string, q: string, a: string | React.ReactNode }[]> = {
      'getting-started': [
         {
            id: 'gs-1',
            q: 'What is CareConnex?',
            a: 'CareConnex is a premium platform connecting families directly with experienced, vetted senior caregivers. We provide the tools to find, interview, hire, and manage care for your aging loved ones without the need for expensive traditional agencies.'
         },
         {
            id: 'gs-2',
            q: 'How does the AI matching work?',
            a: 'Our proprietary AI engine analyzes your specific care needs—such as mobility support, dementia care, or simply companionship—and matches you with caregivers based on their skills, availability, distance, and even personality compatibility to ensure a lasting fit.'
         },
         {
            id: 'gs-3',
            q: 'Can I manage care for a family member living in another state?',
            a: 'Yes. CareConnex is designed for remote family management. Our platform includes a Family Command Center (the Care Journal) where caregivers can log daily activities, meals, and medication adherence in real-time, allowing you to monitor care from anywhere.'
         },
         {
            id: 'gs-4',
            q: 'What types of senior care services are offered?',
            a: 'Caregivers on our platform offer a wide range of non-medical services including companionship, meal preparation, medication reminders, light housekeeping, transportation, mobility assistance, and specialized memory care.'
         }
      ],
      'trust-safety': [
         {
            id: 'ts-1',
            q: 'Are caregivers background checked?',
            a: 'Yes, absolutely. Every caregiver on CareConnex must pass a comprehensive annual background check processed by Checkr before their profile becomes visible to families. We also continually monitor for any new records.'
         },
         {
            id: 'ts-2',
            q: 'How does the review system work?',
            a: 'Only families who have successfully hired and paid a caregiver through CareConnex can leave a review. This ensures that every rating and testimonial is based on a verified, firsthand experience.'
         },
         {
            id: 'ts-3',
            q: 'How does CareConnex protect my personal information?',
            a: 'We use industry-standard encryption to protect your data. Your contact information is kept private and is only shared with a caregiver after a booking is confirmed or when you explicitly choose to share it.'
         },
         {
            id: 'ts-4',
            q: 'What do the different caregiver badges mean?',
            a: 'Badges highlight a caregiver\'s specific achievements on the platform. For example, the "Highly Reliable" badge indicates a caregiver who completes 90-100% of their booked jobs without cancellations, and the "Responds Quickly" badge is for those who reply within 24 hours.'
         }
      ],
      'bookings': [
         {
            id: 'bk-1',
            q: 'How do I interview a caregiver?',
            a: 'We strongly encourage interviews before hiring. You can schedule and conduct secure video interviews directly through the CareConnex platform, making it easy to meet candidates without sharing personal phone numbers or Zoom links.'
         },
         {
            id: 'bk-2',
            q: 'What is a Micro-Visit?',
            a: 'Micro-Visits are short, task-specific appointments like a 30-minute medication reminder or a 45-minute bath visit. Instead of paying for a minimum of 4 hours, you pay a flat rate for the specific task, making it a highly affordable way to supplement care.'
         },
         {
            id: 'bk-3',
            q: 'How does the Care Journal work?',
            a: 'The Care Journal acts as a digital logbook for your family. Caregivers can post photos, note what the senior ate, confirm if medications were taken, and log the day\'s activities. All family members added to your account can view these updates in real-time.'
         },
         {
            id: 'bk-4',
            q: 'Can I schedule recurring care?',
            a: 'Yes, you can easily set up weekly, bi-weekly, or custom recurring schedules with your hired caregiver to ensure consistent care coverage.'
         }
      ],
      'payments': [
         {
            id: 'py-1',
            q: 'How do I pay my caregiver?',
            a: 'All payments are processed securely through our platform via Stripe. You add a credit card or bank account to your profile, and payments are automatically transferred to the caregiver after the shift is completed and hours are verified.'
         },
         {
            id: 'py-2',
            q: 'Does CareConnex take a cut of the caregiver\'s hourly rate?',
            a: 'No. Caregivers keep 100% of the hourly rate they set. CareConnex charges a nominal service fee to families to cover background checks, platform maintenance, and customer support.'
         },
         {
            id: 'py-3',
            q: 'What is the cancellation policy?',
            a: 'If you cancel an appointment with less than 24 hours\' notice, a cancellation fee may apply to compensate the caregiver for their reserved time. Cancellations made further in advance are fully refunded.'
         },
         {
            id: 'py-4',
            q: 'Are there membership fees?',
            a: 'CareConnex offers flexible membership options, including a monthly subscription or a pay-as-you-go model. A premium membership provides reduced booking fees and priority support.'
         }
      ],
      'account': [
         {
            id: 'ac-1',
            q: 'How do I update my care recipient\'s information?',
            a: 'You can update your senior\'s care needs, medical conditions, and daily routines at any time by navigating to the "Care Plan" section in your Family Dashboard.'
         },
         {
            id: 'ac-2',
            q: 'How can I add other family members to my account?',
            a: 'In your Account Settings under "Family Team," you can invite siblings, spouses, or other relatives. You can designate them as "viewers" (to read the Care Journal) or "admins" (who can book care and manage payments).'
         },
         {
            id: 'ac-3',
            q: 'How do I manage notifications?',
            a: 'You can customize your SMS and email notification preferences in your Account Settings. We recommend keeping SMS alerts enabled for important updates like booking confirmations or interview requests.'
         }
      ]
   };

   return (
      <div className="min-h-screen bg-slate-50 font-sans flex flex-col">
         <SEO
            title="Help Center & FAQ | CareConnex"
            description="Find answers to all your questions about finding, hiring, and managing senior caregivers on CareConnex."
            keywords="Help center, FAQ, support, CareConnex, family, senior care"
         />

         {/* Navigation Header */}
         <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
               <div className="flex justify-between items-center h-20">
                  <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
                     <div className="bg-primary-600 p-2 rounded-xl shadow-lg shadow-primary-200/50">
                        <Activity className="text-white w-6 h-6" />
                     </div>
                     <span className="text-2xl font-bold text-slate-900 tracking-tight">CareConnex</span>
                  </div>

                  <nav className="hidden md:flex items-center space-x-8">
                     <button onClick={() => onNavigate('client-signup')} className="text-slate-600 hover:text-primary-600 font-medium transition-colors">Find Care</button>
                     <button onClick={() => onNavigate('caregiver-signup')} className="text-slate-600 hover:text-accent-500 font-medium transition-colors">Find Jobs</button>
                  </nav>

                  <div className="flex items-center space-x-4">
                     <button onClick={() => onNavigate('login')} className="hidden md:block text-slate-600 hover:text-primary-600 font-medium">Log In</button>
                     <Button onClick={() => onNavigate('client-signup')}>Get Started</Button>
                  </div>
               </div>
            </div>
         </header>

         <main className="flex-grow">
            {/* Hero Search Section */}
            <section className="bg-primary-600 text-white py-16 md:py-24">
               <div className="max-w-3xl mx-auto px-4 text-center">
                  <h1 className="text-4xl md:text-5xl font-bold mb-6 tracking-tight">How can we help you?</h1>
                  <div className="relative max-w-2xl mx-auto">
                     <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                        <Search className="h-6 w-6 text-slate-400" />
                     </div>
                     <input 
                        type="text" 
                        placeholder="Search for articles (e.g. background checks, payments)..." 
                        className="block w-full pl-12 pr-4 py-4 rounded-xl text-slate-900 bg-white border-0 shadow-lg focus:ring-4 focus:ring-primary-400/30 text-lg transition-all"
                        readOnly // It's just for visual UI right now
                     />
                  </div>
               </div>
            </section>

            <section className="max-w-7xl mx-auto px-4 py-16 md:py-24">
               <div className="flex flex-col lg:flex-row gap-12">
                  
                  {/* Sidebar Categories */}
                  <div className="lg:w-1/3">
                     <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden sticky top-32">
                        <div className="p-6 bg-slate-50 border-b border-slate-100">
                           <h2 className="text-xl font-bold text-slate-900">Categories</h2>
                        </div>
                        <ul className="divide-y divide-slate-100">
                           {categories.map(category => (
                              <li key={category.id}>
                                 <button 
                                    onClick={() => {
                                       setActiveCategory(category.id);
                                       setOpenFaq(null); // Reset accordion on tab switch
                                    }}
                                    className={`w-full text-left px-6 py-4 flex items-center gap-4 transition-colors ${
                                       activeCategory === category.id 
                                          ? 'bg-primary-50 text-primary-700 border-l-4 border-primary-600' 
                                          : 'text-slate-600 hover:bg-slate-50 border-l-4 border-transparent'
                                    }`}
                                 >
                                    <div className={`${activeCategory === category.id ? 'text-primary-600' : 'text-slate-400'}`}>
                                       {category.icon}
                                    </div>
                                    <span className="font-medium flex-grow">{category.title}</span>
                                    <ChevronRight className={`w-5 h-5 ${activeCategory === category.id ? 'text-primary-600' : 'text-slate-300'}`} />
                                 </button>
                              </li>
                           ))}
                        </ul>
                     </div>
                  </div>

                  {/* FAQ Accordion */}
                  <div className="lg:w-2/3">
                     <div className="mb-8 pb-4 border-b border-slate-200">
                        <h2 className="text-3xl font-bold text-slate-900">
                           {categories.find(c => c.id === activeCategory)?.title}
                        </h2>
                     </div>

                     <div className="space-y-4">
                        {faqs[activeCategory]?.map((faq) => {
                           const isOpen = openFaq === faq.id;
                           return (
                              <div key={faq.id} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all duration-200">
                                 <button 
                                    onClick={() => toggleFaq(faq.id)}
                                    className="w-full text-left px-6 py-5 flex items-center justify-between gap-4 focus:outline-none"
                                 >
                                    <h3 className={`text-lg font-semibold pr-8 ${isOpen ? 'text-primary-600' : 'text-slate-900'}`}>
                                       {faq.q}
                                    </h3>
                                    <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${isOpen ? 'bg-primary-100 text-primary-600' : 'bg-slate-100 text-slate-500'}`}>
                                       {isOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                                    </div>
                                 </button>
                                 
                                 {isOpen && (
                                    <div className="px-6 pb-6 text-slate-600 leading-relaxed border-t border-slate-100 pt-4 animate-in slide-in-from-top-2 fade-in duration-200">
                                       {faq.a}
                                    </div>
                                 )}
                              </div>
                           );
                        })}
                     </div>
                  </div>
               </div>
            </section>

            {/* CTA Section */}
            <section className="py-20 bg-primary-50 border-t border-primary-100">
               <div className="max-w-3xl mx-auto px-4 text-center">
                  <h2 className="text-3xl font-bold text-slate-900 mb-6">Still have questions?</h2>
                  <p className="text-lg text-slate-600 mb-8">Our award-winning member services team is available 7 days a week to help.</p>
                  <div className="flex flex-col sm:flex-row justify-center gap-4">
                     <Button size="lg" onClick={() => onNavigate('client-signup')}>
                        Sign up free
                     </Button>
                     <Button size="lg" variant="secondary" onClick={() => window.location.href = 'mailto:support@careconnex.com'}>
                        Contact Support
                     </Button>
                  </div>
               </div>
            </section>
         </main>

         <Footer onNavigate={onNavigate} />
      </div>
   );
};
