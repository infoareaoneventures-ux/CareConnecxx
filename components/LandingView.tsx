import React from 'react';
import { ViewType } from '../types';
import { SEO, generateOrganizationSchema, generateServiceSchema } from './SEO';

// The ONE public page (founder, 2026-10-12): hero, "look into before you
// book", the eight services, a minimal footer. The other marketing sections
// (featured caregivers, features, FAQ, blog, stats, testimonial, sticky CTA)
// and the pages behind them (/how-it-works, /trust, /help, /family-faq, /blog,
// /care/*, /pricing) were placeholder content and are gone.
import { HeroSection } from './landing/HeroSection';
import { TrustSafetySection } from './landing/TrustSafetySection';
import { ServicesSection } from './landing/ServicesSection';
import { Footer } from './landing/Footer';
import { SiteHeader } from './landing/SiteHeader';

interface LandingViewProps {
   onNavigate: (view: ViewType) => void;
}

export const LandingView: React.FC<LandingViewProps> = ({ onNavigate }) => {

   return (
      <div className="flex flex-col min-h-screen bg-paper-50 font-sans">
         <SEO
            title="Find a Care Provider in Santa Clara County"
            description="Evia connects families in Santa Clara County with local care providers who have completed a background check. Non-medical help at home, coordinated entirely over text."
            keywords="senior care, care provider, elderly care, in-home care, companionship, personal care, dementia care, Santa Clara County"
            schema={{
              '@context': 'https://schema.org',
              '@graph': [
                generateOrganizationSchema(),
                generateServiceSchema(),
                {
                  '@type': 'WebPage',
                  name: 'Evia - Senior Care Marketplace',
                  description: 'Connect with local care providers who have completed a background check. Matching by your care needs, schedule and distance.',
                  url: 'https://www.eviacares.com/'
                }
              ]
            }}
         />

         <SiteHeader />

         <main className="flex-grow">
            <HeroSection onNavigate={onNavigate} />
            <TrustSafetySection onNavigate={onNavigate} />
            <ServicesSection onNavigate={onNavigate} />
            <Footer />
         </main>
      </div>
   );
};
