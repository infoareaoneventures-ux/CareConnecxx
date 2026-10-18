
import React, { useEffect } from 'react';

interface SEOProps {
  title: string;
  description: string;
  keywords?: string;
  image?: string;
  canonicalUrl?: string;
  noindex?: boolean;
  schema?: object;
}

const DEFAULT_IMAGE = 'https://www.eviacares.com/icon-512.png';
const SITE_URL = 'https://www.eviacares.com';

export const SEO: React.FC<SEOProps> = ({
  title,
  description,
  keywords = "senior care, child care, care provider, elderly care, in-home care, finding care, care provider jobs",
  image = DEFAULT_IMAGE,
  canonicalUrl,
  noindex = false,
  schema
}) => {
  useEffect(() => {
    // Update Title
    document.title = `${title} | Evia`;

    // Helper to update or create meta tags
    const updateMeta = (name: string, content: string, attribute = 'name') => {
      let element = document.querySelector(`meta[${attribute}="${name}"]`);
      if (!element) {
        element = document.createElement('meta');
        element.setAttribute(attribute, name);
        document.head.appendChild(element);
      }
      element.setAttribute('content', content);
    };

    // Helper to update or create link tags
    const updateLink = (rel: string, href: string) => {
      let element = document.querySelector(`link[rel="${rel}"]`);
      if (!element) {
        element = document.createElement('link');
        element.setAttribute('rel', rel);
        document.head.appendChild(element);
      }
      element.setAttribute('href', href);
    };

    // Standard Meta
    updateMeta('description', description);
    updateMeta('keywords', keywords);
    updateMeta('robots', noindex ? 'noindex, nofollow' : 'index, follow');

    // Canonical URL
    const canonical = canonicalUrl || `${SITE_URL}${window.location.pathname}`;
    updateLink('canonical', canonical);

    // Open Graph / Facebook
    updateMeta('og:type', 'website', 'property');
    updateMeta('og:title', title, 'property');
    updateMeta('og:description', description, 'property');
    updateMeta('og:image', image, 'property');
    updateMeta('og:url', canonical, 'property');
    updateMeta('og:site_name', 'Evia', 'property');
    updateMeta('og:locale', 'en_US', 'property');

    // Twitter
    updateMeta('twitter:card', 'summary_large_image', 'name');
    updateMeta('twitter:title', title, 'name');
    updateMeta('twitter:description', description, 'name');
    updateMeta('twitter:image', image, 'name');
    updateMeta('twitter:site', '@Evia', 'name');

    // Structured Data (Schema.org)
    if (schema) {
      let scriptElement = document.querySelector('script[type="application/ld+json"]');
      if (!scriptElement) {
        scriptElement = document.createElement('script');
        scriptElement.setAttribute('type', 'application/ld+json');
        document.head.appendChild(scriptElement);
      }
      scriptElement.textContent = JSON.stringify(schema);
    }

    // Cleanup on unmount
    return () => {
      // Note: We don't remove meta tags on unmount to prevent flickering
    };
  }, [title, description, keywords, image, canonicalUrl, noindex, schema]);

  return null;
};

// Pre-built schema generators
export const generateOrganizationSchema = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Evia',
  url: SITE_URL,
  logo: `${SITE_URL}/icon-512.png`,
  description: 'Connect with local care providers who have completed a background check. Matching by your care needs, schedule and distance.',
  sameAs: [
    // Add social media URLs when available
  ],
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    availableLanguage: 'English'
  }
});

export const generateLocalBusinessSchema = () => ({
  '@context': 'https://schema.org',
  '@type': 'LocalBusiness',
  name: 'Evia',
  image: `${SITE_URL}/icon-512.png`,
  url: SITE_URL,
  telephone: '',
  description: 'Senior and child care marketplace connecting families with local care providers who have completed a background check',
  priceRange: '$$',
  areaServed: 'US'
});

export const generateServiceSchema = () => ({
  '@context': 'https://schema.org',
  '@type': 'Service',
  name: 'Senior and Child Care Matching',
  provider: {
    '@type': 'Organization',
    name: 'Evia'
  },
  description: 'Care provider matching for non-medical in-home senior and child care',
  serviceType: 'Non-medical in-home care'
});

export const generateFAQSchema = (faqs: Array<{question: string, answer: string}>) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map(faq => ({
    '@type': 'Question',
    name: faq.question,
    acceptedAnswer: {
      '@type': 'Answer',
      text: faq.answer
    }
  }))
});

