import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, ChevronRight, Users, Briefcase, Globe, LifeBuoy, MessageCircle } from 'lucide-react';
import { BloomMark } from './ui/BloomMark';
import { CARA_CAPABILITIES, CapabilityRole, capabilityLabel, capabilityExample } from '../constants/caraCapabilities';
import { ViewType } from '../types';
import { Footer } from './landing/Footer';
import { Button } from './ui/Button';
import { SEO } from './SEO';

interface HelpPageProps {
  section: 'families' | 'caregivers' | 'general';
  onNavigate: (view: ViewType) => void;
}

// ─── CONTENT ────────────────────────────────────────────────────────────────

const familiesContent = [
  {
    category: 'Getting Started & Finding Care',
    faqs: [
      {
        q: 'What is Evia?',
        a: 'Evia is a premium marketplace connecting families directly with experienced, vetted senior caregivers. Unlike traditional agencies, our platform lets you browse real profiles, read verified reviews, interview caregivers over a video call, and hire — all without costly agency fees.',
      },
      {
        q: 'How do I find a caregiver for my senior family member?',
        a: 'Create a free family account and complete our short care-needs intake. Our AI engine instantly surfaces caregivers matched to your location, schedule, and specific care requirements — whether that is companionship, dementia support, or driving assistance. You can then browse profiles, read reviews, and send a message — or schedule a video interview from a caregiver profile or simply by texting Evia. Once a time is set, both you and the caregiver receive a Google Meet link by text.',
      },
      {
        q: 'What types of senior care services are available?',
        a: 'Caregivers on Evia offer companionship, meal preparation, medication reminders, light housekeeping, transportation, mobility assistance, dementia care, and more. All services are non-medical in nature.',
      },
      {
        q: 'How does AI matching work?',
        a: "Evia's matching engine analyzes your senior's care needs, personality profile, location, and preferred schedule, and cross-references them against each caregiver's verified skills, availability, distance, and past reliability score. The best matches appear at the top of your results.",
      },
      {
        q: 'Can I manage care for a family member who lives in another city?',
        a: 'Yes. The Care Journal feature lets caregivers post daily activity logs, meal notes, medication confirmations, and photos in real time. You can view these updates from anywhere.',
      },
    ],
  },
  {
    category: 'Trust & Safety',
    faqs: [
      {
        q: 'Are caregivers background checked?',
        a: 'Every caregiver on Evia must pass a comprehensive annual background check processed by Checkr before their profile becomes visible to families. We also monitor for new records throughout the year.',
      },
      {
        q: 'How does the review system work?',
        a: 'Only families who have completed a visit with a caregiver through Evia can leave a review, one review per caregiver. This means every star rating and written testimonial reflects a verified, firsthand experience — no fake or unverified reviews.',
      },
      {
        q: 'What do caregiver badges mean?',
        a: '"Highly Reliable" means the caregiver completed 90–100% of recent bookings without a last-minute cancellation. "Responds Quickly" means they typically reply within 24 hours. "Repeat Families" shows how many clients have rebooked them — a strong trust signal.',
      },
      {
        q: 'How is my personal information protected?',
        a: 'Your phone number and home address are never shared with a caregiver until after a booking is confirmed. All messages pass through our encrypted in-app messaging system so your personal contact details stay private.',
      },
      {
        q: 'What if I have a safety concern?',
        a: 'Our Trust & Safety team is available 7 days a week. Use the "Report" button on any profile or booking, or email support@eviacares.com. Urgent safety issues are prioritized and escalated immediately.',
      },
    ],
  },
  {
    category: 'Bookings & Care Management',
    faqs: [
      {
        q: 'How do I interview a caregiver before hiring?',
        a: 'Click "Schedule Interview" on any caregiver profile, or simply text Evia to set up a time. Once the interview is booked, both you and the caregiver receive a Google Meet link by text — it opens in any phone browser, no Google account or app install needed — plus a calendar invite with a reminder. A "Join video call" button also appears on your interview card. Personal phone numbers are never exchanged; Evia coordinates everything. After the call, you can hire directly from the same screen.',
      },
      {
        q: 'What is a Micro-Visit?',
        a: 'Micro-Visits are short, task-specific appointments such as a 30-minute medication reminder ($30) or a 45-minute bath visit ($40). Instead of booking a 4-hour minimum, you pay a flat rate for the specific task — ideal for supplementing regular care.',
      },
      {
        q: 'How does the Care Journal work?',
        a: "The Care Journal is your family's real-time activity feed. After each shift, caregivers log what your senior ate, whether medications were taken, the day's activities, and any notable wellness observations. You can view updates on any device.",
      },
      {
        q: 'Can I set up recurring care?',
        a: 'Yes. When booking, select a recurring frequency — weekly, bi-weekly, or a custom schedule. The same caregiver will be reserved for each shift automatically.',
      },
      {
        q: 'What is your cancellation policy?',
        a: 'You can cancel a visit any time from My Bookings. Nothing is charged until you approve the caregiver’s hours after a visit, so a cancelled visit is never charged. Please give your caregiver as much notice as you can.',
      },
    ],
  },
  {
    category: 'Payments & Subscriptions',
    faqs: [
      {
        q: 'How do I pay my caregiver?',
        a: 'All payments are processed securely through Stripe. Add a credit card or bank account to your profile and payments are automatically released to the caregiver after shift hours are verified — no cash, checks, or Venmo required.',
      },
      {
        q: 'Does Evia charge a service fee?',
        a: 'Evia adds a 9% service fee (minimum $1) to each visit’s charge to cover payment processing and coordinating the visit. Caregivers keep 100% of their hourly rate.',
      },
      {
        q: 'Are there membership plans?',
        a: 'One plan for families: $29.95/month, billed monthly, cancel anytime. Caregivers pay one flat $69.99/year, which covers their background check and driving record check.',
      },
      {
        q: 'What if I am charged incorrectly?',
        a: 'Nothing is charged until you approve the hours. If the submitted hours look wrong, propose a correction from the Timesheets page (or tell Evia) before approving — the caregiver accepts or counters, and our team settles anything escalated.',
      },
    ],
  },
  {
    category: 'Account Settings',
    faqs: [
      {
        q: "How do I update my senior's care profile?",
        a: 'Navigate to the Care Plan section of your Family Dashboard. Here you can update medical conditions, daily routines, dietary restrictions, medications, and emergency contacts at any time.',
      },
      {
        q: 'How do I manage notifications?',
        a: 'In Account Settings → Notifications, you can toggle SMS and email alerts for booking confirmations, interview requests, Care Journal updates, and payment receipts. We recommend keeping SMS on for time-sensitive updates.',
      },
    ],
  },
];

const caregiversContent = [
  {
    category: 'Getting Started',
    faqs: [
      {
        q: 'How do I create a caregiver profile?',
        a: 'Click "Find Jobs" on the homepage and follow our guided signup flow. You will add your experience, skills, availability, hourly rate, and a short bio. After submitting, our team reviews your application and runs your background check through Checkr before activating your profile.',
      },
      {
        q: 'How long does approval take?',
        a: 'Profile review typically takes 1–3 business days. Background check results from Checkr usually arrive within 24–72 hours. You will receive an email and SMS notification as soon as your profile is approved.',
      },
      {
        q: 'Do I need prior professional experience?',
        a: 'Prior senior care experience is valued but not always required for companion or light-housekeeping roles. Specialized roles such as dementia care or medication management do require documented experience or certification.',
      },
      {
        q: 'What does the background check include?',
        a: 'Our annual background check, processed by Checkr, includes a national criminal database search, sex offender registry check, and county courthouse records search. Some positions may include a motor vehicle report.',
      },
    ],
  },
  {
    category: 'Job Board & Applications',
    faqs: [
      {
        q: 'How do I find care jobs?',
        a: 'Once your profile is approved, visit the Job Board to browse open positions near you. Jobs are filtered by distance, care type, schedule, and rate. Apply with one tap — families receive your profile instantly.',
      },
      {
        q: 'Can families find me without me applying?',
        a: 'Yes. Families searching Evia can discover your profile based on their care needs and location. Keeping your profile complete and your availability up to date increases how often you appear in search results.',
      },
      {
        q: 'What happens after I apply to a job?',
        a: 'The family will receive your profile and can message you or schedule a video interview. When an interview is booked, Evia texts both you and the family a Google Meet link that opens in any phone browser — no phone numbers are exchanged. If hired, both parties confirm the booking and it appears on your calendar.',
      },
      {
        q: 'Can I decline a job offer?',
        a: "Yes, you are never obligated to accept a booking. However, maintaining a high response rate and low cancellation rate improves your profile's visibility in search results.",
      },
    ],
  },
  {
    category: 'Managing Your Schedule',
    faqs: [
      {
        q: 'How do I set my availability?',
        a: 'Go to your Caregiver Dashboard → Availability and use the weekly grid to mark the days and times you are available. Families only see and book slots that match your availability.',
      },
      {
        q: 'How do I clock in and out?',
        a: 'At the start of your shift, open the Evia app and tap "Clock In." At the end, tap "Clock Out." Your hours are logged automatically and shared with the family for review before payment is released.',
      },
      {
        q: 'What if I need to cancel a shift?',
        a: 'Cancel as early as possible from your Bookings tab. Last-minute cancellations (within 24 hours) negatively affect your Reliability badge and may incur a short-term visibility reduction on the platform. Repeated cancellations can result in account review.',
      },
      {
        q: 'Can I work with multiple families?',
        a: 'Yes. Evia allows you to manage multiple clients simultaneously as long as shifts do not overlap. Your calendar will flag any conflicts before you confirm a new booking.',
      },
    ],
  },
  {
    category: 'Payouts & Earnings',
    faqs: [
      {
        q: 'How do I get paid?',
        a: 'Once the family approves your submitted hours (or 24 hours pass with no dispute), payment is automatically initiated to your connected bank account via Stripe — no action needed, funds typically arrive within 2 business days. Need money sooner? Request an instant payout from the Payments page (or text PAYOUT to Evia) — Stripe\'s 1% fee (minimum $0.50) is deducted and it arrives in about 30 minutes.',
      },
      {
        q: 'Does Evia take a cut of my rate?',
        a: 'No. Caregivers keep 100% of the hourly rate they set. Evia charges the family a 9% service fee on each visit — your earnings are never reduced.',
      },
      {
        q: 'How do I set or update my hourly rate?',
        a: 'Go to your Profile → Rate Settings. You can set a standard hourly rate and optional rates for 2-senior or 3+-senior households. Our platform shows a market rate suggestion to help you stay competitive.',
      },
      {
        q: 'What if the family disputes my hours?',
        a: 'If a family submits a correction, you will receive a notification to review and accept or decline. If there is no agreement within 24 hours, our support team steps in to mediate using your clock-in/clock-out records.',
      },
    ],
  },
];

const generalContent = [
  {
    category: 'Privacy & Data',
    faqs: [
      {
        q: 'What personal information does Evia collect?',
        a: 'We collect information you provide during signup (name, email, address, payment details) and information generated by your use of the platform (booking history, messages, Care Journal entries). We never sell your personal data to third parties.',
      },
      {
        q: 'How is my financial information protected?',
        a: 'All payment data is handled by Stripe, a PCI-DSS Level 1 certified payment processor. Evia never stores raw credit card numbers on our servers.',
      },
      {
        q: 'Can I delete my account?',
        a: 'Yes. Go to Account Settings → Danger Zone and select "Delete Account." We will permanently remove your personal data within 30 days in accordance with applicable privacy laws. Note that anonymized transaction records may be retained for legal compliance.',
      },
    ],
  },
  {
    category: 'Terms of Service & Community Guidelines',
    faqs: [
      {
        q: 'What is Evia\'s community standard?',
        a: 'All members — families and caregivers alike — must treat one another with dignity and respect. Discrimination, harassment, or fraudulent activity of any kind is prohibited and will result in immediate account suspension.',
      },
      {
        q: 'What happens if someone violates the Terms of Service?',
        a: 'Violations are reviewed by our Trust & Safety team. Depending on severity, consequences range from a warning to permanent account removal and, where applicable, referral to law enforcement.',
      },
      {
        q: 'Can I use Evia to hire caregivers off-platform?',
        a: 'Evia strictly prohibits off-platform arrangements initiated through the platform. Doing so voids background check protections, payment security, and dispute resolution support for both parties.',
      },
    ],
  },
  {
    category: 'Technical Support',
    faqs: [
      {
        q: 'The app is not loading. What should I do?',
        a: 'Try refreshing the page or clearing your browser cache. If the issue persists, contact support@eviacares.com with a description of the problem.',
      },
      {
        q: 'I forgot my password. How do I reset it?',
        a: 'Click "Forgot Password" on the login page and enter your email address. You will receive a reset link within a few minutes. Check your spam folder if it does not arrive.',
      },
      {
        q: 'Which browsers and devices does Evia support?',
        a: 'Evia works on all modern browsers (Chrome, Safari, Firefox, Edge) and is fully responsive on mobile devices. For the best experience, keep your browser updated to the latest version.',
      },
      {
        q: 'How do I report a bug or send product feedback?',
        a: 'Email support@eviacares.com or use the in-app feedback button in your Account Settings. We review every submission and release updates regularly based on user input.',
      },
    ],
  },
];

// ─── SHARED NAV BAR ─────────────────────────────────────────────────────────

const NavBar: React.FC<{ onNavigate: (v: ViewType) => void; onLogin: () => void }> = ({ onNavigate, onLogin }) => (
  <header className="sticky top-0 z-50 bg-paper-50/95 backdrop-blur-sm border-b hairline">
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="flex justify-between items-center h-20">
        <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
          <div className="bg-ink-900 p-2 rounded-xl"><BloomMark className="text-white w-6 h-6" /></div>
          <span className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia</span>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => onNavigate('help-center')} className="text-ink-600 hover:text-ink-900 text-sm font-medium hidden md:block">Help Center</button>
          <button onClick={onLogin} className="text-ink-600 hover:text-ink-900 font-medium">Log In</button>
          <Button onClick={() => onNavigate('client-signup')}>Get Started</Button>
        </div>
      </div>
    </div>
  </header>
);

// ─── ACCORDION ──────────────────────────────────────────────────────────────

const Accordion: React.FC<{ q: string; a: string; id: string; open: boolean; onToggle: () => void }> = ({ q, a, id, open, onToggle }) => (
  <div className="bg-white rounded-xl shadow-sm border hairline overflow-hidden">
    <button id={id} onClick={onToggle} className="w-full text-left px-6 py-5 flex items-center justify-between gap-4">
      <h3 className="text-base font-semibold pr-4 text-ink-900">{q}</h3>
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-paper-100 ${open ? 'text-ink-900' : 'text-ink-600'}`}>
        {open ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
      </div>
    </button>
    {open && <div className="px-6 pb-6 text-ink-600 leading-relaxed border-t hairline pt-4 text-sm">{a}</div>}
  </div>
);

// ─── WHAT YOU CAN ASK EVIA ──────────────────────────────────────────────────
// Sourced from constants/caraCapabilities.ts (the CI-synced mirror of the
// backend capability list) so the help docs never drift from what Evia can do.

const capabilityRoleTitles: Record<CapabilityRole, string> = {
  client: 'For families',
  caregiver: 'For caregivers',
};

const AskEviaSection: React.FC<{ roles: CapabilityRole[] }> = ({ roles }) => (
  <section className="max-w-6xl mx-auto px-4 pt-12">
    <div className="bg-white rounded-2xl border hairline shadow-sm p-6 md:p-8">
      <div className="flex items-center gap-3 mb-2">
        <MessageCircle className="w-6 h-6 text-ink-900" />
        <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">What you can ask Evia</h2>
      </div>
      <p className="text-ink-600 text-sm mb-6">
        Evia is your care assistant — text her, or use the in-app chat. Tell her what you need in one sentence, for example:
      </p>
      <div className={`grid gap-8 ${roles.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {roles.map(role => (
          <div key={role}>
            {roles.length > 1 && (
              <h3 className="text-xs font-bold tracking-widest uppercase text-ink-400 mb-3">{capabilityRoleTitles[role]}</h3>
            )}
            <ul className="space-y-3">
              {CARA_CAPABILITIES[role].map(entry => (
                <li key={entry.id} className="flex flex-col">
                  <span className="text-sm font-semibold text-ink-900">{capabilityLabel(entry)}</span>
                  <span className="text-sm text-ink-600">"{capabilityExample(entry)}"</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  </section>
);

// ─── MAIN COMPONENT ─────────────────────────────────────────────────────────

export const HelpPage: React.FC<HelpPageProps> = ({ section, onNavigate }) => {
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const [activeCat, setActiveCat] = useState(0);
  // ?q= from the Help Center search box: matches across every section's questions and answers.
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get('q') ?? '').trim();
  const searchHits = q
    ? [...familiesContent, ...caregiversContent, ...generalContent].flatMap(c => c.faqs.map(f => ({ ...f, category: c.category })))
        .filter(f => f.q.toLowerCase().includes(q.toLowerCase()) || (typeof f.a === 'string' && f.a.toLowerCase().includes(q.toLowerCase())))
    : null;

  const config = {
    families: {
      title: 'Families Help Center',
      subtitle: 'Everything you need to find, hire, and manage trusted senior care.',
      icon: <Users className="w-7 h-7 text-ink-900" />,
      view: 'help-families' as ViewType,
      content: familiesContent,
      seoTitle: 'Families Help Center | Evia',
    },
    caregivers: {
      title: 'Caregivers Help Center',
      subtitle: 'Set up your profile, find great jobs, and get paid on time.',
      icon: <Briefcase className="w-7 h-7 text-ink-900" />,
      view: 'help-caregivers' as ViewType,
      content: caregiversContent,
      seoTitle: 'Caregivers Help Center | Evia',
    },
    general: {
      title: 'General Help Center',
      subtitle: 'Platform policies, privacy, technical support, and community standards.',
      icon: <Globe className="w-7 h-7 text-ink-900" />,
      view: 'help-general' as ViewType,
      content: generalContent,
      seoTitle: 'General Help Center | Evia',
    },
  }[section];

  const sectionTabs: { label: string; view: ViewType; icon: React.ReactNode }[] = [
    { label: 'Families', view: 'help-families', icon: <Users className="w-4 h-4" /> },
    { label: 'Caregivers', view: 'help-caregivers', icon: <Briefcase className="w-4 h-4" /> },
    { label: 'General', view: 'help-general', icon: <Globe className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-paper-50 flex flex-col font-sans">
      <SEO title={config.seoTitle} description={config.subtitle} keywords={`Evia, help, ${section}`} />
      <NavBar onNavigate={onNavigate} onLogin={() => onNavigate('login')} />

      <main className="flex-grow">
        {/* Hero breadcrumb */}
        <section className="bg-paper-50 border-b hairline py-10">
          <div className="max-w-6xl mx-auto px-4">
            <nav className="flex items-center gap-2 text-sm text-ink-600 mb-4">
              <button onClick={() => onNavigate('help-center')} className="flex items-center gap-1 hover:text-ink-900 transition-colors">
                <LifeBuoy className="w-4 h-4" /> Help Center
              </button>
              <ChevronRight className="w-4 h-4" />
              <span className="text-ink-900 font-medium">{config.title}</span>
            </nav>
            <div className="flex items-center gap-3 mb-2">
              {config.icon}
              <h1 className="text-3xl md:text-4xl font-display font-semibold text-ink-900 tracking-[-0.02em]">{config.title}</h1>
            </div>
            <p className="text-ink-600 mt-2">{config.subtitle}</p>
          </div>
        </section>

        {/* Section tabs */}
        <div className="bg-paper-50 border-b hairline sticky top-20 z-40">
          <div className="max-w-6xl mx-auto px-4">
            <div className="flex gap-1">
              {sectionTabs.map(tab => (
                <button
                  key={tab.view}
                  onClick={() => onNavigate(tab.view)}
                  className={`flex items-center gap-2 px-4 py-4 text-sm font-medium border-b-2 transition-colors ${
                    section === tab.view.replace('help-', '')
                      ? 'border-ink-900 text-ink-900'
                      : 'border-transparent text-ink-600 hover:text-ink-900'
                  }`}
                >
                  {tab.icon}{tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* What you can ask Evia (role-aware; both roles on the general page) */}
        <AskEviaSection
          roles={section === 'families' ? ['client'] : section === 'caregivers' ? ['caregiver'] : ['client', 'caregiver']}
        />

        {/* Content */}
        <section className="max-w-6xl mx-auto px-4 py-12 md:py-16">
          <div className="flex flex-col lg:flex-row gap-12">
            {/* Sidebar */}
            <div className="lg:w-1/4">
              <div className="bg-white rounded-2xl border hairline shadow-sm overflow-hidden sticky top-40">
                <div className="p-5 bg-paper-100 border-b hairline">
                  <p className="text-xs font-bold tracking-widest uppercase text-ink-400">Categories</p>
                </div>
                <ul className="divide-y divide-[rgba(26,31,43,0.08)]">
                  {config.content.map((cat, idx) => (
                    <li key={idx}>
                      <button
                        onClick={() => { setActiveCat(idx); setOpenFaq(null); if (q) setSearchParams({}); }}
                        className={`w-full text-left px-5 py-4 flex items-center justify-between text-sm font-medium transition-colors ${
                          activeCat === idx
                            ? 'bg-paper-100 text-ink-900 border-l-4 border-ink-900'
                            : 'text-ink-600 hover:bg-paper-50 border-l-4 border-transparent'
                        }`}
                      >
                        <span>{cat.category}</span>
                        <ChevronRight className={`w-4 h-4 ${activeCat === idx ? 'text-ink-900' : 'text-ink-400'}`} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* FAQ Accordion */}
            <div className="lg:w-3/4">
              <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-6 pb-4 border-b hairline">
                {searchHits ? `Results for "${q}"` : config.content[activeCat].category}
              </h2>
              {searchHits && searchHits.length === 0 && (
                <p className="text-ink-600 mb-6">No articles match that. Try another word, or text Evia your question.</p>
              )}
              <div className="space-y-4">
                {(searchHits ?? config.content[activeCat].faqs).map((faq, i) => {
                  const id = `${section}-${searchHits ? 'search' : activeCat}-${i}`;
                  return (
                    <Accordion
                      key={id}
                      id={id}
                      q={faq.q}
                      a={faq.a}
                      open={openFaq === id}
                      onToggle={() => setOpenFaq(openFaq === id ? null : id)}
                    />
                  );
                })}
              </div>

              {/* Other sections CTA */}
              <div className="mt-12 grid sm:grid-cols-3 gap-4">
                {sectionTabs.filter(t => t.view !== config.view).map(tab => (
                  <button
                    key={tab.view}
                    onClick={() => onNavigate(tab.view)}
                    className="flex items-center gap-2 px-4 py-3 min-h-[44px] rounded-xl border hairline bg-white hover:shadow-sm transition-all text-sm font-medium text-ink-600 hover:text-ink-900"
                  >
                    {tab.icon}{tab.label} Help <ChevronRight className="w-4 h-4 ml-auto text-ink-400" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 bg-paper-100 border-t hairline">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-3">Still have questions?</h2>
            <p className="text-ink-600 mb-6">Our support team is available 7 days a week.</p>
            <Button size="lg" onClick={() => { window.location.href = 'mailto:support@eviacares.com'; }}>Contact Support</Button>
          </div>
        </section>
      </main>

      <Footer onNavigate={onNavigate} />
    </div>
  );
};
