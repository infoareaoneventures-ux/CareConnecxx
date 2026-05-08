import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Activity, ShieldCheck, Star, Clock, MapPin, ArrowRight, Check } from 'lucide-react';
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
  { name: 'Post-Surgery Recovery', desc: 'Short-term intensive recovery support' },
];

const whyBetter = [
  { label: 'Background check included in $24.95/yr membership', detail: 'vs. Care.com\'s $300 add-on' },
  { label: 'AI-powered matching — not random availability', detail: 'vs. keyword-only search' },
  { label: 'Video interview before your first booking', detail: 'built into every booking flow' },
  { label: 'Instant payouts for caregivers = better retention', detail: 'caregivers stay longer' },
  { label: '$29.95/mo for families — vs. $35/mo on Care.com', detail: 'and no per-booking fees' },
];

export const CityPage: React.FC<CityPageProps> = ({ onNavigate }) => {
  const { city } = useParams<{ city: string }>();
  const navigate = useNavigate();
  const cityData = city ? getCityData(city) : null;

  if (!cityData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-600 mb-4">City not found.</p>
          <Button onClick={() => onNavigate('landing')}>Back to Home</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white font-sans">
      <SEO
        title={cityData.metaTitle}
        description={cityData.metaDescription}
        keywords={`senior care ${cityData.name}, in-home care ${cityData.name}, caregiver ${cityData.name}, ${cityData.county}`}
        schema={{
          '@context': 'https://schema.org',
          '@type': 'LocalBusiness',
          name: `CareConnex — Senior Care in ${cityData.name}`,
          description: cityData.metaDescription,
          url: `https://www.careconnex.com/care/${cityData.slug}`,
          areaServed: {
            '@type': 'City',
            name: cityData.name,
            containedInPlace: { '@type': 'AdministrativeArea', name: cityData.county }
          },
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: '4.9',
            reviewCount: '512',
            bestRating: '5'
          }
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
          <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
            <div className="bg-primary-600 p-1.5 rounded-xl">
              <Activity className="text-white w-5 h-5" />
            </div>
            <span className="text-xl font-bold text-slate-900">CareConnex</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('client-signup')}
              className="hidden sm:block text-sm font-medium text-slate-600 hover:text-primary-600 transition-colors"
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
        <section className="bg-gradient-to-br from-slate-900 via-slate-800 to-primary-900 text-white py-20 lg:py-28">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/10 rounded-full text-sm font-medium mb-6 border border-white/20">
              <MapPin className="w-4 h-4 text-primary-400" />
              {cityData.name}, {cityData.county}
            </div>
            <h1 className="text-4xl md:text-6xl font-bold leading-tight mb-6">
              {cityData.headline}
            </h1>
            <p className="text-xl text-slate-300 max-w-2xl mx-auto mb-10 leading-relaxed">
              {cityData.subheadline}
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-4">
              <Button size="lg" onClick={() => onNavigate('client-signup')} className="bg-primary-500 hover:bg-primary-400">
                Find a Caregiver <ArrowRight className="w-5 h-5 ml-1" />
              </Button>
              <Button size="lg" variant="secondary" onClick={() => onNavigate('caregiver-signup')}
                className="bg-white/10 border-white/20 text-white hover:bg-white/20">
                I'm a Caregiver
              </Button>
            </div>
          </div>
        </section>

        {/* Stats row */}
        <section className="bg-primary-50 border-y border-primary-100 py-8">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
              {cityData.localStats.map((stat, i) => (
                <div key={i}>
                  <p className="text-2xl font-black text-primary-700">{stat.value}</p>
                  <p className="text-sm text-slate-500 mt-1">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Services */}
        <section className="py-16 bg-white">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-3xl font-bold text-slate-900 mb-2">
              Care Services in {cityData.name}
            </h2>
            <p className="text-slate-500 mb-10">All services are available for part-time, full-time, and overnight schedules.</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {careTypes.map((care, i) => (
                <div key={i} className="p-5 border border-slate-200 rounded-2xl hover:border-primary-200 hover:bg-primary-50/30 transition-all">
                  <h3 className="font-bold text-slate-900 mb-1">{care.name}</h3>
                  <p className="text-sm text-slate-500">{care.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section className="py-16 bg-slate-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-3xl font-bold text-slate-900 mb-3">
              What Does In-Home Care Cost in {cityData.name}?
            </h2>
            <p className="text-slate-500 mb-10 max-w-2xl">
              {cityData.name} caregiver hourly rates through CareConnex typically range from {cityData.avgHourlyRate}/hr — compared to $38–$55/hr through traditional agencies.
            </p>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Traditional Agency</p>
                <div className="text-3xl font-black text-slate-400 mb-1">$38–$55<span className="text-sm font-normal">/hr</span></div>
                <p className="text-sm text-slate-400 mb-4">High markup, caregiver earns only $18–22/hr</p>
                <ul className="space-y-2">
                  {['No say in who is assigned', 'Background check — limited', 'Long-term contracts common', 'No video interview option'].map((item, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm text-slate-400">
                      <span className="w-4 h-4 text-slate-200">✗</span> {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-primary-600 rounded-2xl border border-primary-500 p-6 shadow-lg relative">
                <div className="absolute -top-3 left-6">
                  <span className="bg-accent-500 text-white text-xs font-bold px-3 py-1 rounded-full">Best Value</span>
                </div>
                <p className="text-xs font-bold text-primary-200 uppercase tracking-widest mb-3">CareConnex</p>
                <div className="text-3xl font-black text-white mb-1">{cityData.avgHourlyRate}<span className="text-sm font-normal text-primary-200">/hr</span></div>
                <p className="text-sm text-primary-200 mb-4">Caregiver earns full rate · $29.95/mo membership</p>
                <ul className="space-y-2">
                  {['You choose your caregiver', 'Annual Checkr background check included', 'Cancel anytime, no contract', 'Video interview built in'].map((item, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm text-white">
                      <Check className="w-4 h-4 text-primary-300 flex-shrink-0" /> {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Why CareConnex wins */}
        <section className="py-16 bg-white">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-3xl font-bold text-slate-900 mb-3">Why {cityData.name} Families Choose CareConnex</h2>
            <p className="text-slate-500 mb-10">We're not just cheaper — we're built differently.</p>
            <div className="space-y-4">
              {whyBetter.map((item, i) => (
                <div key={i} className="flex items-start gap-4 p-4 border border-slate-200 rounded-xl">
                  <div className="w-8 h-8 bg-primary-50 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Check className="w-4 h-4 text-primary-600" />
                  </div>
                  <div>
                    <p className="font-semibold text-slate-900">{item.label}</p>
                    <p className="text-sm text-slate-400 mt-0.5">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Neighborhoods */}
        <section className="py-12 bg-slate-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-slate-900 mb-6">Neighborhoods We Serve in {cityData.name}</h2>
            <div className="flex flex-wrap gap-3">
              {cityData.nearbyNeighborhoods.map((n, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-full text-sm text-slate-600">
                  <MapPin className="w-3 h-3 text-primary-400" /> {n}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Testimonial */}
        <section className="py-16 bg-white">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <div className="flex justify-center gap-1 mb-5">
              {[...Array(5)].map((_, i) => <Star key={i} className="w-5 h-5 text-yellow-400 fill-yellow-400" />)}
            </div>
            <blockquote className="text-2xl font-medium text-slate-800 leading-relaxed mb-6">
              "{cityData.testimonial.quote}"
            </blockquote>
            <p className="text-primary-600 font-bold">{cityData.testimonial.name}</p>
            <p className="text-sm text-slate-400">{cityData.testimonial.neighborhood}</p>
          </div>
        </section>

        {/* Nearby cities */}
        <section className="py-10 bg-slate-50 border-t border-slate-200">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <p className="text-sm font-semibold text-slate-500 mb-4">Also serving nearby cities:</p>
            <div className="flex flex-wrap gap-3">
              {cityData.nearestCities.map((c, i) => {
                const nearCity = cities.find(x => x.name === c);
                return nearCity ? (
                  <button
                    key={i}
                    onClick={() => navigate(`/care/${nearCity.slug}`)}
                    className="text-sm text-primary-600 hover:underline font-medium"
                  >
                    Senior Care in {c}
                  </button>
                ) : (
                  <span key={i} className="text-sm text-slate-400">{c}</span>
                );
              })}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 bg-primary-600 text-white">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <ShieldCheck className="w-12 h-12 text-primary-300 mx-auto mb-4" />
            <h2 className="text-3xl font-bold mb-4">Find a Caregiver in {cityData.name} Today</h2>
            <p className="text-primary-200 mb-8 max-w-xl mx-auto">
              Browse {cityData.availableCaregivers}+ background-checked caregivers in {cityData.name}. Read reviews, watch intro videos, and interview before your first booking.
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-4">
              <Button size="lg" onClick={() => onNavigate('client-signup')}
                className="bg-white text-primary-700 hover:bg-primary-50">
                Get Matched Free <ArrowRight className="w-5 h-5 ml-1" />
              </Button>
              <Button size="lg" variant="secondary" onClick={() => onNavigate('how-it-works')}
                className="border-white/30 text-white hover:bg-white/10">
                How It Works
              </Button>
            </div>
            <p className="text-primary-300 text-sm mt-5">No credit card required · Cancel anytime</p>
          </div>
        </section>
      </main>

      <Footer onNavigate={onNavigate} />
    </div>
  );
};
