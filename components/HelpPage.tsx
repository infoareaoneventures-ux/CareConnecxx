import React, { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, ChevronRight, Users, Briefcase, Globe, LifeBuoy } from 'lucide-react';
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
        a: 'Evia is a premium marketplace connecting families directly with experienced, vetted senior caregivers. Unlike traditional agencies, our platform lets you browse real profiles, read verified reviews, conduct video interviews, and hire — all without costly agency fees.',
      },
      {
        q: 'How do I find a caregiver for my senior family member?',
        a: 'Create a free family account and complete our short care-needs intake. Our AI engine instantly surfaces caregivers matched to your location, schedule, and specific care requirements — whether that is companionship, dementia support, or driving assistance. You can then browse profiles, read reviews, and send a message or schedule a video interview directly.',
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
        a: 'Yes. The Care Journal feature lets caregivers post daily activity logs, meal notes, medication confirmations, and photos in real time. Every family member you invite to your account can view these updates from anywhere.',
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
        a: 'Only families who have completed a paid booking through Evia can leave a review. This means every star rating and written testimonial reflects a verified, firsthand experience — no fake or unverified reviews.',
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
        a: 'Click "Schedule Interview" on any caregiver profile to book a secure, built-in video interview — no Zoom link or phone number exchange required. After the call, you can hire directly from the same screen.',
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
        a: 'Cancellations made more than 24 hours before a shift are fully refunded. Cancellations made within 24 hours may incur a small fee to compensate the caregiver for their reserved time.',
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
        a: 'Evia charges families a nominal platform service fee on each booking to cover background checks, payment processing, and 7-day support. Caregivers keep 100% of their hourly rate.',
      },
      {
        q: 'Are there membership plans?',
        a: 'Yes. Our Premium membership reduces per-booking service fees and unlocks priority support and advanced search filters. You can also use Evia on a pay-as-you-go basis with no monthly commitment.',
      },
      {
        q: 'What if I am charged incorrectly?',
        a: 'Contact our support team within 7 days of the shift and we will review the hours log and issue a correction or refund as appropriate.',
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
        q: 'Can I add other family members to my account?',
        a: 'Yes. Go to Account Settings → Family Team and invite family members by email. You can set each person as an "Admin" (can book and pay) or a "Viewer" (read-only access to the Care Journal).',
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
        a: 'The family will receive your profile and can message you or schedule a video interview directly through the platform. If hired, both parties confirm the booking and it appears on your calendar.',
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
        a: 'Once the family approves your submitted hours (or 24 hours pass with no dispute), payment is automatically initiated to your connected bank account via Stripe. Standard transfer times are 2–5 business days.',
      },
      {
        q: 'Does Evia take a cut of my rate?',
        a: 'No. Caregivers keep 100% of the hourly rate they set. Evia charges the family a platform service fee — your earnings are never reduced.',
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
        a: 'Try refreshing the page or clearing your browser cache. If using the mobile app, close and reopen it or check for updates in the App Store / Google Play. If the issue persists, contact support@eviacares.com with a description of the problem.',
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
        a: 'Email feedback@eviacares.com or use the in-app feedback button in your Account Settings. We review every submission and release updates regularly based on user input.',
      },
    ],
  },
];

// ─── SHARED NAV BAR ─────────────────────────────────────────────────────────

const NavBar: React.FC<{ onNavigate: (v: ViewType) => void; onLogin: () => void }> = ({ onNavigate, onLogin }) => (
  <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100">
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="flex justify-between items-center h-20">
        <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
          <div className="bg-primary-600 p-2 rounded-xl shadow-lg shadow-primary-200/50"><Activity className="text-white w-6 h-6" /></div>
          <span className="text-2xl font-bold text-slate-900 tracking-tight">Evia</span>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => onNavigate('help-center')} className="text-slate-500 hover:text-primary-600 text-sm font-medium hidden md:block">Help Center</button>
          <button onClick={onLogin} className="text-slate-600 hover:text-primary-600 font-medium">Log In</button>
          <Button onClick={() => onNavigate('client-signup')}>Get Started</Button>
        </div>
      </div>
    </div>
  </header>
);

// ─── ACCORDION ──────────────────────────────────────────────────────────────

const Accordion: React.FC<{ q: string; a: string; id: string; open: boolean; onToggle: () => void }> = ({ q, a, id, open, onToggle }) => (
  <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
    <button id={id} onClick={onToggle} className="w-full text-left px-6 py-5 flex items-center justify-between gap-4">
      <h3 className={`text-base font-semibold pr-4 ${open ? 'text-primary-600' : 'text-slate-900'}`}>{q}</h3>
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${open ? 'bg-primary-100 text-primary-600' : 'bg-slate-100 text-slate-500'}`}>
        {open ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
      </div>
    </button>
    {open && <div className="px-6 pb-6 text-slate-600 leading-relaxed border-t border-slate-100 pt-4 text-sm">{a}</div>}
  </div>
);

// ─── MAIN COMPONENT ─────────────────────────────────────────────────────────

export const HelpPage: React.FC<HelpPageProps> = ({ section, onNavigate }) => {
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const [activeCat, setActiveCat] = useState(0);

  const config = {
    families: {
      title: 'Families Help Center',
      subtitle: 'Everything you need to find, hire, and manage trusted senior care.',
      icon: <Users className="w-7 h-7 text-primary-600" />,
      view: 'help-families' as ViewType,
      content: familiesContent,
      seoTitle: 'Families Help Center | Evia',
    },
    caregivers: {
      title: 'Caregivers Help Center',
      subtitle: 'Set up your profile, find great jobs, and get paid on time.',
      icon: <Briefcase className="w-7 h-7 text-accent-500" />,
      view: 'help-caregivers' as ViewType,
      content: caregiversContent,
      seoTitle: 'Caregivers Help Center | Evia',
    },
    general: {
      title: 'General Help Center',
      subtitle: 'Platform policies, privacy, technical support, and community standards.',
      icon: <Globe className="w-7 h-7 text-teal-600" />,
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
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <SEO title={config.seoTitle} description={config.subtitle} keywords={`Evia, help, ${section}`} />
      <NavBar onNavigate={onNavigate} onLogin={() => onNavigate('login')} />

      <main className="flex-grow">
        {/* Hero breadcrumb */}
        <section className="bg-white border-b border-slate-200 py-10">
          <div className="max-w-6xl mx-auto px-4">
            <nav className="flex items-center gap-2 text-sm text-slate-500 mb-4">
              <button onClick={() => onNavigate('help-center')} className="flex items-center gap-1 hover:text-primary-600 transition-colors">
                <LifeBuoy className="w-4 h-4" /> Help Center
              </button>
              <ChevronRight className="w-4 h-4" />
              <span className="text-slate-900 font-medium">{config.title}</span>
            </nav>
            <div className="flex items-center gap-3 mb-2">
              {config.icon}
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900">{config.title}</h1>
            </div>
            <p className="text-slate-500 mt-2">{config.subtitle}</p>
          </div>
        </section>

        {/* Section tabs */}
        <div className="bg-white border-b border-slate-100 sticky top-20 z-40">
          <div className="max-w-6xl mx-auto px-4">
            <div className="flex gap-1">
              {sectionTabs.map(tab => (
                <button
                  key={tab.view}
                  onClick={() => onNavigate(tab.view)}
                  className={`flex items-center gap-2 px-4 py-4 text-sm font-medium border-b-2 transition-colors ${
                    section === tab.view.replace('help-', '')
                      ? 'border-primary-600 text-primary-600'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {tab.icon}{tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        <section className="max-w-6xl mx-auto px-4 py-12 md:py-16">
          <div className="flex flex-col lg:flex-row gap-12">
            {/* Sidebar */}
            <div className="lg:w-1/4">
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden sticky top-40">
                <div className="p-5 bg-slate-50 border-b border-slate-100">
                  <p className="text-xs font-bold tracking-widest uppercase text-slate-400">Categories</p>
                </div>
                <ul className="divide-y divide-slate-100">
                  {config.content.map((cat, idx) => (
                    <li key={idx}>
                      <button
                        onClick={() => { setActiveCat(idx); setOpenFaq(null); }}
                        className={`w-full text-left px-5 py-4 flex items-center justify-between text-sm font-medium transition-colors ${
                          activeCat === idx
                            ? 'bg-primary-50 text-primary-700 border-l-4 border-primary-600'
                            : 'text-slate-600 hover:bg-slate-50 border-l-4 border-transparent'
                        }`}
                      >
                        <span>{cat.category}</span>
                        <ChevronRight className={`w-4 h-4 ${activeCat === idx ? 'text-primary-500' : 'text-slate-300'}`} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* FAQ Accordion */}
            <div className="lg:w-3/4">
              <h2 className="text-2xl font-bold text-slate-900 mb-6 pb-4 border-b border-slate-200">
                {config.content[activeCat].category}
              </h2>
              <div className="space-y-4">
                {config.content[activeCat].faqs.map((faq, i) => {
                  const id = `${section}-${activeCat}-${i}`;
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
                    className="flex items-center gap-2 px-4 py-3 rounded-xl border border-slate-200 bg-white hover:border-primary-300 hover:bg-primary-50 transition-all text-sm font-medium text-slate-600 hover:text-primary-700"
                  >
                    {tab.icon}{tab.label} Help <ChevronRight className="w-4 h-4 ml-auto text-slate-300" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 bg-primary-50 border-t border-primary-100">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <h2 className="text-2xl font-bold text-slate-900 mb-3">Still have questions?</h2>
            <p className="text-slate-600 mb-6">Our support team is available 7 days a week.</p>
            <Button size="lg" onClick={() => { window.location.href = 'mailto:support@eviacares.com'; }}>Contact Support</Button>
          </div>
        </section>
      </main>

      <Footer onNavigate={onNavigate} />
    </div>
  );
};
