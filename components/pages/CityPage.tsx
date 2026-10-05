import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ShieldCheck, Clock, MapPin, ArrowRight, Check } from 'lucide-react';
import { BloomMark } from '../ui/BloomMark';
import { ViewType } from '../../types';
import { SEO } from '../SEO';
import { Footer } from '../landing/Footer';
import { getCityData, cities } from '../../utils/cityData';
import { Button } from '../ui/Button';

interface CityPageProps {
  onNavigate: (view: ViewType) => void;
}

const careTypes = [
  { name: 'Companion Care', desc: 'Conversation, activities, errands, meal prep' },
  { name: 'Personal Care', desc: 'Bathing, dressing, grooming, mobility assistance' },
  { name: 'Dementia Care', desc: 'Specialized memory care and behavioral support' },
  { name: 'Respite Care', desc: 'Temporary relief for family caregivers' },
  { name: 'Overnight Care', desc: '12-hour overnight supervision and assistance' },
];

// Founder, 2026-10-04: no competitor comparisons (stale, invite a letter), no "AI",
// no "no per-booking fees" (there is a 9% service fee on each visit). Plain facts.
const whyBetter = [
  { label: 'Background check included in the $69.99/yr caregiver membership' },
  { label: 'Matching by your care needs, schedule and distance' },
  { label: 'Interview before your first booking' },
  { label: 'Caregivers keep 100% of their rate, with instant payouts' },
  { label: '$29.95/mo for families, plus a 9% service fee on each visit' },
];

export const CityPage: React.FC<CityPageProps> = ({ onNavigate }) => {
  const { city } = useParams<{ city: string }>();
  const navigate = useNavigate();
  const cityData = city ? getCityData(city) : null;

  if (!cityData) {
    return (
      <div className="min-h-screen bg-paper-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-ink-600 mb-4">City not found.</p>
          <Button onClick={() => onNavigate('landing')}>Back to Home</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper-50 font-sans">
      <SEO
        title={cityData.metaTitle}
        description={cityData.metaDescription}
        keywords={`senior care ${cityData.name}, in-home care ${cityData.name}, caregiver ${cityData.name}, ${cityData.county}`}
        schema={{
          '@context': 'https://schema.org',
          '@type': 'LocalBusiness',
          name: `Evia — Senior Care in ${cityData.name}`,
          description: cityData.metaDescription,
          url: `https://www.eviacares.com/care/${cityData.slug}`,
          areaServed: {
            '@type': 'City',
            name: cityData.name,
            containedInPlace: { '@type': 'AdministrativeArea', name: cityData.county }
          }
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-50 bg-paper-50/95 backdrop-blur-sm border-b hairline">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
          <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
            <BloomMark className="text-ink-900 w-5 h-5" />
            <span className="font-display text-xl font-semibold text-ink-900">Evia</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('client-signup')}
              className="hidden sm:block text-sm font-medium text-ink-600 hover:text-ink-900 transition-colors"
            >
              Log in
            </button>
            <Button size="sm" onClick={() => onNavigate('client-signup')}>
              Find Care in {cityData.name}
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="bg-paper-50 py-20 lg:py-28">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-paper-100 border hairline rounded-full text-sm font-medium text-ink-600 mb-6">
              <MapPin className="w-4 h-4 text-ink-400" />
              {cityData.name}, {cityData.county}
            </div>
            <h1 className="font-display text-4xl md:text-6xl font-semibold text-ink-900 tracking-[-0.02em] leading-tight mb-6">
              {cityData.headline}
            </h1>
            <p className="text-xl text-ink-600 max-w-2xl mx-auto mb-10 leading-relaxed">
              {cityData.subheadline}
            </p>
            <div className="flex flex-col sm:flex-row justify-center items-center gap-4">
              <Button size="lg" onClick={() => onNavigate('client-signup')}>
                Find a Caregiver <ArrowRight className="w-5 h-5 ml-1" />
              </Button>
              <Button size="lg" variant="secondary" onClick={() => onNavigate('caregiver-signup')}>
                I'm a Caregiver
              </Button>
            </div>
          </div>
        </section>

        {/* Services */}
        <section className="py-16 bg-paper-50">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="font-display text-3xl font-semibold text-ink-900 tracking-[-0.02em] mb-2">
              Care Services in {cityData.name}
            </h2>
            <p className="text-ink-600 mb-10">All services are available for part-time, full-time, and overnight schedules.</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {careTypes.map((care, i) => (
                <div key={i} className="p-5 bg-white border hairline rounded-2xl hover:shadow-sm transition-all">
                  <h3 className="font-semibold text-ink-900 mb-1">{care.name}</h3>
                  <p className="text-sm text-ink-600">{care.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section className="py-16 bg-paper-100 border-y hairline">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="font-display text-3xl font-semibold text-ink-900 tracking-[-0.02em] mb-3">
              What Does In-Home Care Cost in {cityData.name}?
            </h2>
            {/* Founder, 2026-10-04: no invented rate ranges, no agency comparison — the facts only. */}
            <p className="text-ink-600 mb-6 max-w-2xl">
              Caregivers on Evia set their own hourly rates and keep 100% of them. You see each caregiver's rate on their profile before you book.
            </p>
            <p className="text-ink-600 max-w-2xl">
              Families pay $29.95 a month for membership, plus a 9% service fee on each visit that covers payment processing and coordinating the visit. The caregiver's annual membership includes a background check, so there is no extra charge to you for that.
            </p>
          </div>
        </section>

        {/* Why Evia wins */}
        <section className="py-16 bg-paper-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="font-display text-3xl font-semibold text-ink-900 tracking-[-0.02em] mb-3">Why {cityData.name} Families Choose Evia</h2>
            <p className="text-ink-600 mb-10">Built for families and caregivers.</p>
            <div className="space-y-4">
              {whyBetter.map((item, i) => (
                <div key={i} className="flex items-start gap-4 p-4 bg-white border hairline rounded-xl">
                  <div className="w-8 h-8 bg-paper-100 rounded-2xl flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Check className="w-4 h-4 text-ink-900" />
                  </div>
                  <div>
                    <p className="font-semibold text-ink-900">{item.label}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Neighborhoods */}
        <section className="py-12 bg-paper-100 border-y hairline">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="font-display text-2xl font-semibold text-ink-900 tracking-[-0.02em] mb-6">Neighborhoods We Serve in {cityData.name}</h2>
            <div className="flex flex-wrap gap-3">
              {cityData.nearbyNeighborhoods.map((n, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border hairline rounded-full text-sm text-ink-600">
                  <MapPin className="w-3 h-3 text-ink-400" /> {n}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Nearby cities */}
        <section className="py-10 bg-paper-100 border-t hairline">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <p className="text-sm font-semibold text-ink-600 mb-4">Also serving nearby cities:</p>
            <div className="flex flex-wrap gap-3">
              {cityData.nearestCities.map((c, i) => {
                const nearCity = cities.find(x => x.name === c);
                return nearCity ? (
                  <button
                    key={i}
                    onClick={() => navigate(`/care/${nearCity.slug}`)}
                    className="text-sm text-ink-600 hover:text-ink-900 hover:underline font-medium"
                  >
                    Senior Care in {c}
                  </button>
                ) : (
                  <span key={i} className="text-sm text-ink-400">{c}</span>
                );
              })}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 bg-paper-50 border-t hairline">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <div className="w-14 h-14 bg-paper-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <ShieldCheck className="w-7 h-7 text-ink-900" />
            </div>
            <h2 className="font-display text-3xl font-semibold text-ink-900 tracking-[-0.02em] mb-4">Find a Caregiver in {cityData.name} Today</h2>
            <p className="text-ink-600 mb-8 max-w-xl mx-auto">
              Browse caregivers in {cityData.name} who have completed a background check. Read reviews and interview before your first booking.
            </p>
            <div className="flex flex-col sm:flex-row justify-center items-center gap-4">
              <Button size="lg" onClick={() => onNavigate('client-signup')}>
                Get Matched Free <ArrowRight className="w-5 h-5 ml-1" />
              </Button>
              <button
                onClick={() => onNavigate('how-it-works')}
                className="min-h-[44px] px-4 text-ink-600 hover:text-ink-900 font-medium transition-colors"
              >
                How It Works →
              </button>
            </div>
            <p className="text-ink-400 text-sm mt-5">No credit card required · Cancel anytime</p>
          </div>
        </section>
      </main>

      <Footer onNavigate={onNavigate} />
    </div>
  );
};
