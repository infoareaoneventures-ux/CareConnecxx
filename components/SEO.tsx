
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

const DEFAULT_IMAGE = 'https://careconnex-d4c8b.web.app/icon-512.png';
const SITE_URL = 'https://careconnex-d4c8b.web.app';

export const SEO: React.FC<SEOProps> = ({
  title,
  description,
  keywords = "senior care, caregiver, elderly care, home health aide, finding care, caregiving jobs",
  image = DEFAULT_IMAGE,
  canonicalUrl,
  noindex = false,
  schema
}) => {
  useEffect(() => {
    // Update Title
    document.title = `${title} | CareConnex`;

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
    updateMeta('og:site_name', 'CareConnex', 'property');
    updateMeta('og:locale', 'en_US', 'property');

    // Twitter
    updateMeta('twitter:card', 'summary_large_image', 'name');
    updateMeta('twitter:title', title, 'name');
    updateMeta('twitter:description', description, 'name');
    updateMeta('twitter:image', image, 'name');
    updateMeta('twitter:site', '@CareConnex', 'name');

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
  name: 'CareConnex',
  url: SITE_URL,
  logo: `${SITE_URL}/icon-512.png`,
  description: 'Connect with verified caregivers instantly. AI-powered matching for senior care.',
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
  name: 'CareConnex',
  image: `${SITE_URL}/icon-512.png`,
  url: SITE_URL,
  telephone: '',
  description: 'Senior care marketplace connecting families with verified local caregivers',
  priceRange: '$$',
  areaServed: 'US'
});

export const generateServiceSchema = () => ({
  '@context': 'https://schema.org',
  '@type': 'Service',
  name: 'Senior Care Matching',
  provider: {
    '@type': 'Organization',
    name: 'CareConnex'
  },
  description: 'AI-powered caregiver matching for senior care',
  serviceType: 'Health Care'
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

