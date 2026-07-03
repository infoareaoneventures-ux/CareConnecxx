import React, { useState } from 'react';
import { Activity, Menu, X, Users, Briefcase } from 'lucide-react';
import { ViewType } from '../types';
import { Button } from './ui/Button';
import { SEO, generateOrganizationSchema, generateServiceSchema, generateFAQSchema } from './SEO';
import { faqs } from './landing/FAQSection';

// Sub-components
import { HeroSection } from './landing/HeroSection';
import { StatsBar } from './landing/StatsBar';
import { FeaturedCaregiversSection } from './landing/FeaturedCaregiversSection';
import { TrustSafetySection } from './landing/TrustSafetySection';
import { FeaturesSection } from './landing/FeaturesSection';
import { CaregiverSection } from './landing/CaregiverSection';
import { Footer } from './landing/Footer';
import { ServicesSection } from './landing/ServicesSection';
import { FAQSection } from './landing/FAQSection';
import { BlogSection } from './landing/BlogSection';
import { MobileStickyCTA } from './landing/MobileStickyCTA';

interface LandingViewProps {
   onNavigate: (view: ViewType) => void;
}

export const LandingView: React.FC<LandingViewProps> = ({ onNavigate }) => {
   const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

   return (
      <div className="flex flex-col min-h-screen bg-white font-sans pb-20 md:pb-0">
         <SEO
            title="Find Trusted Senior Caregivers Near You"
            description="Evia connects families with verified local caregivers using AI matching. Find in-home care, respite care, and dementia care for your loved ones."
            keywords="senior care, caregiver, elderly care, home health aide, respite care, dementia care, in-home care, find caregivers"
            schema={{
              '@context': 'https://schema.org',
              '@graph': [
                generateOrganizationSchema(),
                generateServiceSchema(),
                generateFAQSchema(faqs),
                {
                  '@type': 'WebPage',
                  name: 'Evia - Senior Care Marketplace',
                  description: 'Connect with verified caregivers instantly. AI-powered matching for senior care.',
                  url: 'https://www.eviacares.com/',
                  aggregateRating: {
                    '@type': 'AggregateRating',
                    ratingValue: '4.9',
                    reviewCount: '512',
                    bestRating: '5',
                    worstRating: '1'
                  }
                }
              ]
            }}
         />

         {/* Navigation Bar */}
         <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100 transition-all duration-300">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
               <div className="flex justify-between items-center h-20">
                  {/* Logo */}
                  <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
                     <div className="bg-primary-600 p-2 rounded-2xl shadow-xl shadow-primary-200/50">
                        <Activity className="text-white w-6 h-6" />
                     </div>
                     <span className="text-2xl font-bold text-slate-900 tracking-tight">Evia</span>
                  </div>

                  {/* Desktop Nav */}
                  <nav className="hidden md:flex items-center space-x-8">
                     <button onClick={() => onNavigate('client-signup')} className="text-slate-600 hover:text-primary-600 font-medium transition-colors">Find Care</button>
                     <button onClick={() => onNavigate('caregiver-signup')} className="text-slate-600 hover:text-accent-500 font-medium transition-colors">Find Jobs</button>
                  </nav>

                  {/* Auth Buttons */}
                  <div className="hidden md:flex items-center space-x-4">
                     <button
                        onClick={() => onNavigate('help-center')}
                        className="text-slate-600 hover:text-primary-600 font-medium px-4 py-2"
                     >
                        Help
                     </button>
                     <button
                        onClick={() => onNavigate('login')}
                        className="text-slate-600 hover:text-primary-600 font-medium px-4 py-2 border border-slate-300 rounded-full hover:border-primary-400 transition-colors"
                     >
                        Log In
                     </button>

                     {/* Two prominent CTAs route into the unified phone-first onboarding */}
                     <button
                        onClick={() => onNavigate('client-signup')}
                        className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white font-semibold px-5 py-2.5 rounded-full text-sm transition-colors shadow-md shadow-primary-200"
                     >
                        <Users className="w-4 h-4" />
                        Find a Caregiver
                     </button>
                     <button
                        onClick={() => onNavigate('caregiver-signup')}
                        className="flex items-center gap-2 bg-white border border-accent-300 hover:border-accent-500 text-accent-600 font-semibold px-5 py-2.5 rounded-full text-sm transition-colors"
                     >
                        <Briefcase className="w-4 h-4" />
                        Apply as a Caregiver
                     </button>
                  </div>

                  {/* Mobile Menu Button */}
                  <div className="md:hidden">
                     <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="text-slate-600 p-2">
                        {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
                     </button>
                  </div>
               </div>
            </div>

            {/* Mobile Menu Dropdown */}
            {isMobileMenuOpen && (
               <div className="md:hidden bg-white border-t border-slate-100 absolute w-full shadow-xl animate-slide-in">
                  <div className="px-4 pt-2 pb-6 space-y-2">
                     <button onClick={() => onNavigate('client-signup')} className="block w-full text-left px-3 py-3 text-base font-medium text-slate-700 hover:bg-slate-50 rounded-lg">Find Care</button>
                     <button onClick={() => onNavigate('caregiver-signup')} className="block w-full text-left px-3 py-3 text-base font-medium text-slate-700 hover:bg-slate-50 rounded-lg">Find Jobs</button>
                     <button onClick={() => onNavigate('help-center')} className="block w-full text-left px-3 py-3 text-base font-medium text-slate-700 hover:bg-slate-50 rounded-lg">Help</button>
                     <div className="border-t border-slate-100 my-2"></div>
                     <button onClick={() => { setIsMobileMenuOpen(false); onNavigate('login'); }} className="block w-full text-left px-3 py-3 text-base font-medium text-primary-600 hover:bg-primary-50 rounded-lg">Log In</button>
                     <Button fullWidth onClick={() => { setIsMobileMenuOpen(false); onNavigate('client-signup'); }} variant="primary">
                        Find Care — For Families
                     </Button>
                     <Button fullWidth onClick={() => { setIsMobileMenuOpen(false); onNavigate('caregiver-signup'); }} variant="secondary" className="mt-2">
                        Find Jobs — For Caregivers
                     </Button>
                  </div>
               </div>
            )}
         </header>

         <main className="flex-grow">
            <HeroSection onNavigate={onNavigate} />
            <StatsBar />
            <FeaturedCaregiversSection onNavigate={onNavigate} />
            <TrustSafetySection onNavigate={onNavigate} />
            <FeaturesSection onNavigate={onNavigate} />
            <ServicesSection onNavigate={onNavigate} />
            <FAQSection onNavigate={onNavigate} />
            <BlogSection />
            <CaregiverSection onNavigate={onNavigate} />
            <Footer onNavigate={onNavigate} />
         </main>

         {/* Mobile Sticky CTA */}
         <MobileStickyCTA onNavigate={onNavigate} />
      </div>
   );
};
