import React, { useState } from 'react';
import { X, Star, MapPin, Shield, CheckCircle, Heart, CreditCard, ChevronUp, ChevronDown, Zap, MessageSquare, Calendar } from 'lucide-react';
import { Caregiver } from '../types';
import { DEFAULT_CAREGIVER_AVATAR } from '../constants';
import { CaregiverVerificationBadges } from './shared/CaregiverVerificationBadges';

type Tab = 'summary' | 'reviews' | 'calendar';

interface CaregiverProfileModalProps {
  caregiver: Caregiver;
  onClose: () => void;
  onRequestInterview?: () => void;
  onBookNow?: () => void;
  onMessage?: () => void;
  onToggleFavorite?: () => void;
  isFavorite?: boolean;
  hasInterviewScheduled?: boolean;
}

// ─── Availability Grid ────────────────────────────────────────────────────────

const DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function AvailabilityGrid({ weeklyAvailability, availability }: { weeklyAvailability?: any; availability?: string[] }) {
  // Normalize weeklyAvailability keys to lowercase
  const normalizedWeekly: Record<string, any[]> = {};
  if (weeklyAvailability) {
    Object.entries(weeklyAvailability).forEach(([k, v]) => {
      normalizedWeekly[k.toLowerCase()] = v as any[];
    });
  }

  // Detect if availability[] contains day names vs time-of-day names
  const DAY_ALIASES: Record<string, number> = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };
  const avail = availability || [];
  const containsDayNames = avail.some(a => DAY_ALIASES[a.toLowerCase().trim()] !== undefined);

  const grid = DAY_KEYS.map((day, idx) => {
    let am = false, pm = false;

    // 1. Structured weeklyAvailability (time slots per day)
    if (normalizedWeekly[day]?.length) {
      normalizedWeekly[day].forEach((slot: any) => {
        const h = parseInt((slot.start || '0').split(':')[0]);
        if (h < 12) am = true; else pm = true;
      });
      return { am, pm };
    }

    // 2. availability[] contains day names — mark that specific day available (both AM + PM)
    if (containsDayNames) {
      const isAvail = avail.some(a => DAY_ALIASES[a.toLowerCase().trim()] === idx);
      return { am: isAvail, pm: isAvail };
    }

    // 3. availability[] contains time-of-day strings — applies to every day
    if (avail.length) {
      am = avail.some(a => /morning|am|early/i.test(a));
      pm = avail.some(a => /afternoon|evening|pm|late/i.test(a));
      // If none match, treat any entry as "generally available"
      if (!am && !pm && avail.length > 0) { am = true; pm = true; }
    }

    return { am, pm };
  });

  const Cell = ({ on }: { on: boolean }) => on ? (
    <div className="w-7 h-7 rounded-full bg-teal-500 flex items-center justify-center">
      <CheckCircle className="w-4 h-4 text-white" />
    </div>
  ) : (
    <div className="w-7 h-7 rounded-full bg-slate-100" />
  );

  return (
    <div>
      <div className="grid grid-cols-8 text-center text-[11px] font-bold text-slate-500 mb-2">
        <div />
        {DAYS_SHORT.map((d, i) => <div key={i}>{d}</div>)}
      </div>
      {(['am', 'pm'] as const).map(period => (
        <div key={period} className="grid grid-cols-8 items-center text-center mb-1.5">
          <div className="text-[10px] font-bold text-slate-500 uppercase text-right pr-2">{period}</div>
          {grid.map((d, i) => (
            <div key={i} className="flex justify-center">
              <Cell on={d[period]} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Collapsible Section ──────────────────────────────────────────────────────

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-slate-200 py-5 px-6">
      <button
        className="w-full flex items-center justify-between text-left mb-3"
        onClick={() => setOpen(v => !v)}
      >
        <span className="font-bold text-slate-900">{title}</span>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>
      {open && children}
    </div>
  );
}

function Check({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-slate-700">
      <CheckCircle className="w-4 h-4 text-teal-500 flex-shrink-0" />
      {label}
    </p>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const CaregiverProfileModal: React.FC<CaregiverProfileModalProps> = ({
  caregiver,
  onClose,
  onRequestInterview,
  onBookNow,
  onMessage,
  onToggleFavorite,
  isFavorite = false,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [imgErrored, setImgErrored] = useState(false);

  if (!caregiver) return null;

  const photo = (!imgErrored && (caregiver.imageUrl || caregiver.photo || (caregiver as any).photoURL)) || DEFAULT_CAREGIVER_AVATAR;
  const name = caregiver.name || 'Caregiver';
  const firstName = name.split(' ')[0];
  const rate = typeof caregiver.hourlyRate === 'number' ? caregiver.hourlyRate : null;
  const rating = typeof caregiver.rating === 'number' ? caregiver.rating : 0;
  const reviewCount = caregiver.reviewCount || 0;
  const distance = typeof caregiver.distance === 'number' ? caregiver.distance : null;
  const location = caregiver.city || caregiver.location || 'Santa Clara County';
  const neighborhood = (caregiver as any).neighborhood as string | undefined;
  const bio = caregiver.bio || '';
  const skills = Array.isArray(caregiver.skills) ? caregiver.skills : [];
  const certs = Array.isArray(caregiver.certifications) ? caregiver.certifications : [];
  const jobTypes = (caregiver as any).jobTypes as string[] | undefined;
  const languages = (caregiver as any).languages as string[] | undefined;
  const bgClear = caregiver.backgroundCheckStatus === 'clear';

  const lastActive = (caregiver as any).lastActive as string | undefined;
  const activeStr = (() => {
    if (!lastActive) return null;
    const diff = Date.now() - new Date(lastActive).getTime();
    const days = Math.floor(diff / 86400000);
    if (days < 1) return 'active today';
    if (days < 30) return `active ${days}d ago`;
    return `active ${Math.floor(days / 30)}mo ago`;
  })();

  const tabs: { id: Tab; label: string }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'reviews', label: `Reviews${reviewCount ? ` (${reviewCount})` : ''}` },
    { id: 'calendar', label: 'Calendar' },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal panel */}
      <div className="relative bg-white w-full max-w-2xl h-[95vh] sm:h-[90vh] sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col">

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 bg-white/90 hover:bg-slate-100 rounded-full p-2 shadow transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5 text-slate-700" />
        </button>

        {/* ── Non-scrolling header ── */}
        <div className="px-6 pt-6 pb-0 flex-shrink-0">

          {/* Photo + name row */}
          <div className="flex items-start gap-5">
            <div className="relative flex-shrink-0">
              <img
                src={photo}
                alt={name}
                className="w-28 h-28 rounded-xl object-cover border border-slate-200"
                onError={() => setImgErrored(true)}
              />
              {onToggleFavorite && (
                <button
                  onClick={onToggleFavorite}
                  className="absolute bottom-2 right-2 bg-white rounded-full p-1.5 shadow-md hover:bg-slate-50 transition-colors"
                  aria-label={isFavorite ? 'Remove from saved' : 'Save caregiver'}
                >
                  <Heart className={`w-4 h-4 ${isFavorite ? 'fill-red-500 text-red-500' : 'text-slate-400'}`} />
                </button>
              )}
            </div>

            <div className="flex-1 min-w-0 pt-1 pr-10">
              <h2 className="text-2xl font-bold text-slate-900 mb-1 leading-tight">{name}</h2>
              <p className="text-sm text-slate-500 flex items-center gap-1 mb-1">
                <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                {location}{distance !== null ? ` (${distance.toFixed(0)} miles)` : ''}
              </p>
              {rate !== null && (
                <p className="text-sm font-semibold text-slate-700 mb-1">
                  ${rate} per hour for 1 senior
                </p>
              )}
              {rating > 0 && (
                <div className="flex items-center gap-0.5 mb-1">
                  {[...Array(5)].map((_, i) => (
                    <Star key={i} className={`w-3.5 h-3.5 ${i < Math.floor(rating) ? 'text-teal-500 fill-current' : 'text-slate-200'}`} />
                  ))}
                  <span className="text-xs text-slate-500 ml-1">{rating.toFixed(1)} ({reviewCount})</span>
                </div>
              )}
              {activeStr && (
                <p className="text-xs text-primary-600 flex items-center gap-1 font-medium">
                  <Zap className="w-3 h-3 fill-current" /> {activeStr}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <CaregiverVerificationBadges verified={caregiver.verified} backgroundCheckStatus={caregiver.backgroundCheckStatus} />
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-5 space-y-2">
            <button
              onClick={onBookNow}
              className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-bold text-sm rounded-xl transition-colors"
            >
              Request a Booking
            </button>
            <div className="flex gap-2">
              <button
                onClick={onMessage}
                className="flex-1 py-2 border border-slate-300 text-slate-700 font-semibold text-sm rounded-xl hover:bg-slate-50 transition-colors flex items-center justify-center gap-1.5"
              >
                <MessageSquare className="w-4 h-4" /> Message
              </button>
              <button
                onClick={onRequestInterview}
                className="flex-1 py-2 border border-slate-300 text-slate-700 font-semibold text-sm rounded-xl hover:bg-slate-50 transition-colors flex items-center justify-center gap-1.5"
              >
                <Calendar className="w-4 h-4" /> Interview
              </button>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex border-b border-slate-200 mt-5">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-primary-600 text-primary-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Scrollable tab content ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── SUMMARY TAB ── */}
          {activeTab === 'summary' && (
            <>
              {/* Looking for */}
              <div className="px-6 py-5 border-b border-slate-200">
                <div className="flex flex-col sm:flex-row gap-5">
                  <div className="flex-1">
                    <h3 className="font-bold text-slate-900 mb-3">Looking for...</h3>
                    <div className="space-y-1.5">
                      {jobTypes && jobTypes.length > 0 ? jobTypes.map(jt => (
                        <Check key={jt} label={jt.charAt(0).toUpperCase() + jt.slice(1).replace('-', ' ') + ' jobs'} />
                      )) : (
                        <>
                          <Check label="Occasional jobs" />
                          <Check label="Part-time & Full-time jobs" />
                        </>
                      )}
                    </div>
                    {lastActive && (
                      <p className="text-xs text-slate-400 mt-4">
                        Last updated {new Date(lastActive).toLocaleDateString()}
                      </p>
                    )}
                  </div>

                  <div className="flex-shrink-0">
                    <button
                      onClick={() => setActiveTab('calendar')}
                      className="text-xs font-semibold text-primary-600 hover:underline block mb-2 text-right w-full sm:w-auto"
                    >
                      See Full Calendar →
                    </button>
                    <AvailabilityGrid
                      weeklyAvailability={(caregiver as any).weeklyAvailability}
                      availability={caregiver.availability}
                    />
                  </div>
                </div>
              </div>

              {/* About */}
              <Section title={`About ${firstName}`}>
                <div className="flex flex-col sm:flex-row gap-5">
                  <div className="flex-1">
                    {bio ? (
                      <p className="text-sm text-slate-700 leading-relaxed mb-4">{bio}</p>
                    ) : (
                      <p className="text-sm text-slate-400 italic mb-4">No bio provided.</p>
                    )}
                    {languages && languages.length > 0 && (
                      <p className="text-sm text-slate-700 mb-4">
                        <span className="font-semibold">Languages:</span> {languages.join(', ')}
                      </p>
                    )}
                    {skills.length > 0 && (
                      <div>
                        <p className="text-sm font-semibold text-slate-700 mb-2">Other Services Provided</p>
                        <div className="space-y-1.5">
                          {skills.slice(0, 6).map(s => <Check key={s} label={s} />)}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex sm:flex-col gap-2 sm:items-end flex-shrink-0">
                    {bgClear && (
                      <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 whitespace-nowrap">
                        <Shield className="w-4 h-4 text-teal-500" /> Background check
                      </div>
                    )}
                    {(caregiver as any).acceptsCreditCards && (
                      <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 whitespace-nowrap">
                        <CreditCard className="w-4 h-4 text-blue-500" /> Accepts credit cards
                      </div>
                    )}
                  </div>
                </div>
              </Section>

              {/* Experience */}
              <Section title="Experience">
                <div className="grid sm:grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Care Experience</p>
                    {skills.length > 0 ? (
                      <div className="space-y-2.5">
                        {skills.map(skill => (
                          <div key={skill} className="flex items-start gap-2">
                            <CheckCircle className="w-4 h-4 text-teal-500 flex-shrink-0 mt-0.5" />
                            <div>
                              <p className="text-sm font-medium text-slate-800">{skill}</p>
                              {caregiver.experience ? (
                                <p className="text-xs text-slate-500">{caregiver.experience} years experience</p>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400 italic">No specific experience listed</p>
                    )}
                  </div>

                  {rate !== null && (
                    <div>
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Rates</p>
                      <p className="text-sm text-slate-700 mb-1">${rate} per hour for 1 senior</p>
                      {(caregiver as any).rateFor2Seniors && (
                        <p className="text-sm text-slate-700">${(caregiver as any).rateFor2Seniors} per hour for 2 seniors</p>
                      )}
                    </div>
                  )}
                </div>
              </Section>

              {/* Willing to help with */}
              {(caregiver.hasTransportation !== undefined || caregiver.acceptsMicroVisits !== undefined || (caregiver as any).petFriendly !== undefined) && (
                <Section title="Willing to help with...">
                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
                    {caregiver.hasTransportation && <Check label="Transportation (caregiver's car)" />}
                    {caregiver.acceptsMicroVisits && <Check label="Micro-visits (30 min)" />}
                    {(caregiver as any).petFriendly && <Check label="Pet care" />}
                    {(caregiver as any).lightHousekeeping && <Check label="Light housekeeping" />}
                    {(caregiver as any).mealPrep && <Check label="Meal preparation" />}
                    {(caregiver as any).medicationManagement && <Check label="Medication management" />}
                    {(caregiver as any).nonSmoker && <Check label="Non-smoking household" />}
                    {(caregiver as any).covidVaccinated && <Check label="COVID-19 vaccinated" />}
                  </div>
                </Section>
              )}

              {/* Background */}
              {caregiver.education && (
                <Section title="Background" defaultOpen={false}>
                  <p className="text-sm text-slate-700">{caregiver.education}</p>
                </Section>
              )}

              {/* Locations */}
              <Section title="Locations" defaultOpen={false}>
                <div className="space-y-2">
                  {(caregiver.city || location) && (
                    <p className="text-sm text-slate-700">
                      <span className="font-semibold">Lives in:</span> {caregiver.city || location}
                    </p>
                  )}
                  {neighborhood && (
                    <p className="text-sm text-slate-700">
                      <span className="font-semibold">Neighborhood:</span> {neighborhood}
                    </p>
                  )}
                  <p className="text-sm text-slate-700">
                    <span className="font-semibold">Willing to work within:</span>{' '}
                    {caregiver.travelRadius ? `${caregiver.travelRadius} miles` : '25 miles'}
                  </p>
                </div>
              </Section>
            </>
          )}

          {/* ── REVIEWS TAB ── */}
          {activeTab === 'reviews' && (
            <div className="px-6 py-8">
              {reviewCount === 0 ? (
                <div className="text-center py-12">
                  <Star className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                  <p className="text-slate-500 font-semibold">No reviews yet</p>
                  <p className="text-sm text-slate-400 mt-1">Be the first to review after your booking.</p>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-4 mb-6">
                    <span className="text-5xl font-bold text-slate-900">{rating.toFixed(1)}</span>
                    <div>
                      <div className="flex items-center gap-0.5 mb-1">
                        {[...Array(5)].map((_, i) => (
                          <Star key={i} className={`w-5 h-5 ${i < Math.floor(rating) ? 'text-teal-500 fill-current' : 'text-slate-200'}`} />
                        ))}
                      </div>
                      <p className="text-sm text-slate-500">{reviewCount} review{reviewCount !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  <p className="text-sm text-slate-400 text-center italic">Full review details are available after booking.</p>
                </div>
              )}
            </div>
          )}

          {/* ── CALENDAR TAB ── */}
          {activeTab === 'calendar' && (
            <div className="px-6 py-5">
              <h3 className="font-bold text-slate-900 mb-4">Weekly Availability</h3>
              <AvailabilityGrid
                weeklyAvailability={(caregiver as any).weeklyAvailability}
                availability={caregiver.availability}
              />
              {caregiver.availability && caregiver.availability.length > 0 && (
                <div className="mt-6">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Available Times</p>
                  <div className="flex flex-wrap gap-2">
                    {caregiver.availability.map((slot, i) => (
                      <span key={i} className="px-3 py-1 bg-teal-50 text-teal-700 text-sm rounded-full border border-teal-200 font-medium">
                        {slot}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {!(caregiver as any).weeklyAvailability && (!caregiver.availability || caregiver.availability.length === 0) && (
                <p className="text-sm text-slate-400 italic mt-4">No availability information provided.</p>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
