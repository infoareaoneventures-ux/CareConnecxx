import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  Star, MapPin, CheckCircle, ChevronLeft, Shield, Award, Clock,
  Car, CreditCard, TrendingUp, Users, Zap, Heart, MessageSquare,
  Video, Languages, GraduationCap, Briefcase, Home,
} from 'lucide-react';
import { auth, db } from '../lib/firebase';
import { chatService } from '../services/chatService';
import { useAccessGates } from '../hooks/useAccessGates';
import { ClientNavigation } from './client/ClientNavigation';

interface CaregiverProfile {
  id: string;
  firstName: string;
  lastName: string;
  photo?: string;
  rating: number;
  reviewCount: number;
  repeatFamilies: number;
  totalBookings: number;
  responseTimeHours: number;
  cancellationRate: 'low' | 'medium' | 'high';
  hourlyRate: number;
  rateFor2Seniors?: number;
  rateFor3Seniors?: number;
  rateFor4Seniors?: number;
  minimumHoursPerBooking?: number;
  hourlyFlexible?: boolean;
  city: string;
  distance: number;
  experience: number;
  bio: string;
  languages: string[];
  skills: string[];
  specialSituations: string[];
  willingToHelpWith: string[];
  certifications: string[];
  education?: string;
  verified: boolean;
  acceptsCreditCards: boolean;
  hasReliableTransportation: boolean;
  serviceRadius: number;
  availability: Record<string, boolean>;
  lastActiveIso?: string;
}

type Review = { id: string; reviewerName: string; rating: number; comment: string; dateIso: string };

type Tab = 'summary' | 'reviews' | 'calendar' | 'about';

const SENIOR_WILLING_TO_HELP = [
  'Laundry', 'Light Housekeeping', 'Errand Help', 'Grocery Shopping',
  'Meal Preparation', 'Transportation', 'Medication Reminders',
  'Companionship', 'Pet Care', 'House Sitting',
];

const SENIOR_SITUATIONS = [
  'Dementia / Alzheimer\'s', 'Parkinson\'s', 'Post-Surgery Recovery',
  'Hospice & End-of-Life', 'Overnights', 'Split Shifts',
  'Wheelchair / Mobility Support', 'Hospital Discharge',
];

function formatLastActive(iso?: string): string {
  if (!iso) return 'active recently';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `active ${mins < 2 ? 'just now' : `${mins} min ago`}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `active ${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `active ${days} day${days !== 1 ? 's' : ''} ago`;
}

function mapRawToProfile(id: string, data: any): CaregiverProfile {
  const firstName = data.firstName || data.name?.split(' ')[0] || 'Caregiver';
  const lastName = data.lastName || data.name?.split(' ').slice(1).join(' ') || '';
  const rawAvail = data.weeklyAvailability || data.availability;
  const DAYS_ORDER = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const availability: Record<string, boolean> = Array.isArray(rawAvail)
    ? Object.fromEntries(
        DAYS_ORDER.map(d => [d, rawAvail.map((v: string) => v.toLowerCase().trim()).includes(d)])
      )
    : (rawAvail && typeof rawAvail === 'object'
        ? Object.fromEntries(
            DAYS_ORDER.map(d => {
              const val = rawAvail[d] ?? rawAvail[d.charAt(0).toUpperCase() + d.slice(1)];
              return [d, Array.isArray(val) ? val.length > 0 : !!val];
            })
          )
        : { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false });
  return {
    id,
    firstName,
    lastName,
    photo: data.photoURL || data.photo || data.imageUrl || data.profilePhoto,
    rating: data.rating ?? 5.0,
    reviewCount: data.reviewCount ?? data.totalReviews ?? 0,
    repeatFamilies: data.repeatFamilies ?? 0,
    totalBookings: data.completedJobs ?? data.totalBookings ?? 0,
    responseTimeHours: data.responseTimeHours ?? 1,
    cancellationRate: data.cancellationRate || 'low',
    hourlyRate: data.hourlyRate ?? 25,
    rateFor2Seniors: data.rateFor2Seniors,
    rateFor3Seniors: data.rateFor3Seniors,
    rateFor4Seniors: data.rateFor4Seniors,
    minimumHoursPerBooking: data.minimumHoursPerBooking ?? 3,
    hourlyFlexible: data.hourlyFlexible ?? false,
    city: data.city || data.location?.city || 'Nearby',
    distance: data.distance ?? Math.floor(Math.random() * 15) + 1,
    experience: data.experience ?? data.yearsExperience ?? 0,
    bio: data.bio || data.about || '',
    languages: data.languages || ['English'],
    skills: data.skills || data.specializations || data.specialties || [],
    specialSituations: data.specialSituations || [],
    willingToHelpWith: data.willingToHelpWith || [],
    certifications: data.certifications || [],
    education: data.education,
    verified: data.backgroundCheckComplete || data.verified || false,
    acceptsCreditCards: data.acceptsCreditCards ?? true,
    hasReliableTransportation: data.hasReliableTransportation ?? false,
    serviceRadius: data.serviceRadius ?? 25,
    availability,
    lastActiveIso: data.lastActive || data.lastActiveIso || new Date().toISOString(),
  };
}

export default function ClientCaregiverProfile() {
  const navigate = useNavigate();
  const { caregiverId } = useParams();
  const location = useLocation();
  const passedData = (location.state as any)?.caregiverData;
  const [caregiver, setCaregiver] = useState<CaregiverProfile | null>(
    passedData && caregiverId ? mapRawToProfile(caregiverId, passedData) : null
  );
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(!passedData);
  const [tab, setTab] = useState<Tab>('summary');
  const { gate, Modals: GateModals } = useAccessGates();

  useEffect(() => {
    if (!caregiverId) return;
    fetchCaregiverProfile(caregiverId);
    fetchReviews(caregiverId);
  }, [caregiverId]);

  const fetchCaregiverProfile = async (id: string) => {
    try {
      const [userSnap, cgSnap] = await Promise.all([
        db!.collection('users').doc(id).get().catch(() => null),
        db!.collection('caregivers').doc(id).get().catch(() => null),
      ]);

      const userExists = userSnap?.exists;
      const cgExists = cgSnap?.exists;

      if (!userExists && !cgExists) {
        if (!passedData) setCaregiver(null);
        return;
      }

      const data: any = { ...(cgSnap?.data() || {}), ...(userSnap?.data() || {}) };
      setCaregiver(mapRawToProfile(id, data));
    } catch (err) {
      console.error('Error fetching caregiver:', err);
      // passedData already applied on mount; only clear if nothing was set
      if (!passedData) setCaregiver(null);
    } finally {
      setLoading(false);
    }
  };

  const fetchReviews = async (id: string) => {
    try {
      const snap = await db!.collection('reviews')
        .where('caregiverId', '==', id)
        .orderBy('rating', 'desc')
        .limit(20)
        .get();
      const list: Review[] = snap.docs.map(d => {
        const r: any = d.data();
        return {
          id: d.id,
          reviewerName: r.clientName || 'A client',
          rating: r.rating || 5,
          comment: r.comment || r.feedback || '',
          dateIso: r.date || r.createdAt || new Date().toISOString(),
        };
      });
      setReviews(list);
    } catch {
      setReviews([]);
    }
  };

  const fullName = caregiver ? `${caregiver.firstName} ${caregiver.lastName}`.trim() : '';

  const handleMessage = () => {
    if (!caregiver) return;
    gate('message', fullName, async () => {
      try {
        const currentUid = auth.currentUser?.uid;
        const currentName = auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || 'Client';
        if (currentUid) {
          const roomId = await chatService.getOrCreateChatRoom(currentUid, currentName, caregiver.id, fullName);
          navigate(`/client/inbox?room=${roomId}`);
        } else {
          navigate('/client/inbox');
        }
      } catch {
        navigate('/client/inbox');
      }
    });
  };

  const handleInterview = () => {
    if (!caregiver) return;
    gate('interview', fullName, () => {
      navigate(`/client/interviews?caregiver=${caregiver.id}`);
    });
  };

  const handleRequestBooking = () => {
    if (!caregiver) return;
    gate('booking', fullName, () => {
      navigate(`/client/book/${caregiver.id}`);
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="flex items-center justify-center h-[calc(100vh-64px)]">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
        </div>
      </div>
    );
  }

  if (!caregiver) {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-3xl mx-auto px-4 py-16 text-center">
          <p className="text-slate-500 mb-4">Caregiver not found.</p>
          <button onClick={() => navigate('/client/find-caregivers')} className="px-5 py-2 bg-primary-600 text-white rounded-full font-semibold">
            Back to search
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-4"
        >
          <ChevronLeft className="w-4 h-4" /> Back to search
        </button>

        {/* Header row: name + tabs */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6">
          <div className="flex flex-col md:flex-row md:items-start gap-5">
            <div className="relative flex-shrink-0">
              <div className="w-28 h-28 rounded-full bg-slate-200 overflow-hidden flex items-center justify-center">
                {caregiver.photo ? (
                  <img src={caregiver.photo} alt={fullName} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-3xl font-semibold text-slate-400">
                    {caregiver.firstName.charAt(0)}{caregiver.lastName.charAt(0)}
                  </span>
                )}
              </div>
              {caregiver.verified && (
                <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-primary-600 rounded-full flex items-center justify-center border-2 border-white">
                  <CheckCircle className="w-4 h-4 text-white" />
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-slate-900">{fullName}</h1>
              <div className="flex items-center gap-3 mt-1 text-sm text-slate-600">
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-4 h-4" />
                  {caregiver.city} ({caregiver.distance} miles)
                </span>
                <span className="text-slate-300">·</span>
                <span className="font-semibold text-slate-900">${caregiver.hourlyRate}</span>
                <span className="text-slate-500">/hr for 1 senior</span>
              </div>
              <div className="flex items-center gap-1 mt-1 text-xs text-slate-500">
                <Zap className="w-3 h-3 text-accent-500" />
                {formatLastActive(caregiver.lastActiveIso)}
              </div>

              {/* Tabs */}
              <div className="mt-4 flex gap-1 border-b border-slate-200 -mb-5">
                {(['summary', 'reviews', 'calendar', 'about'] as Tab[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
                      tab === t
                        ? 'border-primary-600 text-primary-700'
                        : 'border-transparent text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Two-column body */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          {/* Main column */}
          <div className="space-y-5">
            {tab === 'summary' && <SummaryTab caregiver={caregiver} />}
            {tab === 'reviews' && <ReviewsTab caregiver={caregiver} reviews={reviews} />}
            {tab === 'calendar' && <CalendarTab caregiver={caregiver} />}
            {tab === 'about' && <AboutTab caregiver={caregiver} />}
          </div>

          {/* Sticky sidebar */}
          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center gap-0.5 mb-1">
                {[...Array(5)].map((_, i) => (
                  <Star
                    key={i}
                    className={`w-4 h-4 ${i < Math.round(caregiver.rating) ? 'text-accent-400 fill-current' : 'text-slate-200 fill-current'}`}
                  />
                ))}
                <span className="ml-1.5 text-sm font-semibold text-slate-900">{caregiver.rating.toFixed(1)}</span>
              </div>
              <p className="text-xs text-slate-500">
                {caregiver.reviewCount} reviews{caregiver.repeatFamilies > 0 ? ` · ${caregiver.repeatFamilies} repeat families` : ''}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                Responds in {caregiver.responseTimeHours} hour{caregiver.responseTimeHours !== 1 ? 's' : ''}
              </p>

              <button
                onClick={handleRequestBooking}
                className="w-full mt-4 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors"
              >
                Request a Booking
              </button>

              <div className="grid grid-cols-2 gap-2 mt-2">
                <button
                  onClick={handleMessage}
                  className="py-2 text-sm font-semibold border border-slate-200 text-slate-700 rounded-full hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
                >
                  <MessageSquare className="w-4 h-4" />
                  Message
                </button>
                <button
                  onClick={handleInterview}
                  className="py-2 text-sm font-semibold border border-slate-200 text-slate-700 rounded-full hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
                >
                  <Video className="w-4 h-4" />
                  Interview
                </button>
              </div>
            </div>

            {/* Trust column */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Trust & Reliability</h3>
              <ul className="space-y-2.5 text-sm">
                <TrustRow
                  show={caregiver.verified}
                  icon={<Shield className="w-4 h-4 text-primary-600" />}
                  label="Background check"
                />
                <TrustRow
                  show={caregiver.cancellationRate === 'low'}
                  icon={<TrendingUp className="w-4 h-4 text-green-600" />}
                  label="Low cancellation rate"
                />
                <TrustRow
                  show
                  icon={<Zap className="w-4 h-4 text-accent-500" />}
                  label={`Responds in ${caregiver.responseTimeHours} hour${caregiver.responseTimeHours !== 1 ? 's' : ''}`}
                />
                <TrustRow
                  show={caregiver.acceptsCreditCards}
                  icon={<CreditCard className="w-4 h-4 text-blue-600" />}
                  label="Accepts credit cards"
                />
                <TrustRow
                  show={caregiver.hasReliableTransportation}
                  icon={<Car className="w-4 h-4 text-blue-600" />}
                  label="Reliable transportation"
                />
                <TrustRow
                  show={caregiver.repeatFamilies > 0}
                  icon={<Users className="w-4 h-4 text-blue-600" />}
                  label={`Booked by ${caregiver.repeatFamilies} repeat famil${caregiver.repeatFamilies === 1 ? 'y' : 'ies'}`}
                />
                <TrustRow
                  show={caregiver.totalBookings > 0}
                  icon={<Briefcase className="w-4 h-4 text-slate-600" />}
                  label={`${caregiver.totalBookings} bookings completed`}
                />
              </ul>
            </div>
          </aside>
        </div>
      </main>

      <GateModals />
    </div>
  );
}

// ─── Section: Summary tab ────────────────────────────────────────
const SummaryTab: React.FC<{ caregiver: CaregiverProfile }> = ({ caregiver }) => (
  <>
    <Card title={`About ${caregiver.firstName}`}>
      {caregiver.bio ? (
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{caregiver.bio}</p>
      ) : (
        <p className="text-sm text-slate-400 italic">No bio yet.</p>
      )}
      {caregiver.languages.length > 0 && (
        <div className="mt-4 flex items-center gap-2 text-sm text-slate-600">
          <Languages className="w-4 h-4 text-slate-400" />
          <span className="font-semibold text-slate-700">Languages:</span>
          <span>{caregiver.languages.join(', ')}</span>
        </div>
      )}
    </Card>

    <Card title="Senior Care Services" icon={<Heart className="w-4 h-4 text-primary-600" />}>
      {caregiver.skills.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {caregiver.skills.map(s => (
            <span key={s} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-medium">
              <CheckCircle className="w-3 h-3" /> {s}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400 italic">No services listed.</p>
      )}
    </Card>

    <Card title="Rates" icon={<Briefcase className="w-4 h-4 text-primary-600" />}>
      <ul className="text-sm text-slate-700 space-y-1">
        <li><span className="font-semibold">${caregiver.hourlyRate}/hr</span> for 1 senior</li>
        {caregiver.rateFor2Seniors && <li><span className="font-semibold">${caregiver.rateFor2Seniors}/hr</span> for 2 seniors</li>}
        {caregiver.rateFor3Seniors && <li><span className="font-semibold">${caregiver.rateFor3Seniors}/hr</span> for 3 seniors</li>}
        {caregiver.rateFor4Seniors && <li><span className="font-semibold">${caregiver.rateFor4Seniors}/hr</span> for 4 seniors</li>}
        {caregiver.minimumHoursPerBooking && (
          <li className="text-slate-500">{caregiver.minimumHoursPerBooking}-hour minimum per booking</li>
        )}
        {caregiver.hourlyFlexible && <li className="text-slate-500">Open to flat rates for part-time / full-time jobs</li>}
      </ul>
    </Card>

    <div className="grid sm:grid-cols-2 gap-4">
      <Card title="Willing to help with">
        <ChecklistGrid all={SENIOR_WILLING_TO_HELP} selected={caregiver.willingToHelpWith} />
      </Card>
      <Card title="Special situations">
        <ChecklistGrid all={SENIOR_SITUATIONS} selected={caregiver.specialSituations} />
      </Card>
    </div>

    <Card title="Background" icon={<GraduationCap className="w-4 h-4 text-primary-600" />}>
      <div className="space-y-3 text-sm text-slate-700">
        {caregiver.education && (
          <div>
            <span className="font-semibold">Education:</span> {caregiver.education}
          </div>
        )}
        {caregiver.certifications.length > 0 && (
          <div>
            <span className="font-semibold block mb-1.5">Certifications:</span>
            <div className="flex flex-wrap gap-1.5">
              {caregiver.certifications.map(c => (
                <span key={c} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-medium">
                  <Award className="w-3 h-3" /> {c}
                </span>
              ))}
            </div>
          </div>
        )}
        {!caregiver.education && caregiver.certifications.length === 0 && (
          <p className="text-slate-400 italic">No background info added yet.</p>
        )}
      </div>
    </Card>

    <Card title="Locations" icon={<Home className="w-4 h-4 text-primary-600" />}>
      <p className="text-sm text-slate-700">
        <span className="font-semibold">Lives in:</span> {caregiver.city}
      </p>
      <p className="text-sm text-slate-700 mt-1">
        <span className="font-semibold">Willing to travel:</span> {caregiver.serviceRadius} miles
      </p>
    </Card>
  </>
);

// ─── Section: Reviews tab ────────────────────────────────────────
const ReviewsTab: React.FC<{ caregiver: CaregiverProfile; reviews: Review[] }> = ({ caregiver, reviews }) => (
  <Card title={`${caregiver.reviewCount || reviews.length} Reviews`}>
    {reviews.length === 0 ? (
      <p className="text-sm text-slate-400 italic">No reviews yet.</p>
    ) : (
      <div className="divide-y divide-slate-100">
        {reviews.map(r => (
          <div key={r.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">{r.reviewerName}</p>
              <span className="text-xs text-slate-400">{new Date(r.dateIso).toLocaleDateString()}</span>
            </div>
            <div className="flex items-center gap-0.5 mt-0.5">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className={`w-3.5 h-3.5 ${i < r.rating ? 'text-accent-400 fill-current' : 'text-slate-200 fill-current'}`} />
              ))}
            </div>
            {r.comment && <p className="text-sm text-slate-700 mt-1.5 leading-relaxed">{r.comment}</p>}
          </div>
        ))}
      </div>
    )}
  </Card>
);

// ─── Section: Calendar tab ───────────────────────────────────────
const CalendarTab: React.FC<{ caregiver: CaregiverProfile }> = ({ caregiver }) => {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <Card title="Weekly Availability" icon={<Clock className="w-4 h-4 text-primary-600" />}>
      <div className="grid grid-cols-7 gap-2">
        {days.map((d, i) => {
          const avail = !!caregiver.availability[d];
          return (
            <div
              key={d}
              className={`p-3 rounded-xl text-center ${avail ? 'bg-primary-50 text-primary-700 border border-primary-200' : 'bg-slate-50 text-slate-400 border border-slate-200'}`}
            >
              <p className="text-xs font-semibold">{labels[i]}</p>
              {avail && <CheckCircle className="w-4 h-4 mx-auto mt-1.5" />}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 mt-4">
        For specific date availability, use "Request a Booking" or Message to ask about a date.
      </p>
    </Card>
  );
};

// ─── Section: About tab (same content, leaner) ───────────────────
const AboutTab: React.FC<{ caregiver: CaregiverProfile }> = ({ caregiver }) => (
  <>
    <Card title={`About ${caregiver.firstName}`}>
      {caregiver.bio ? (
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{caregiver.bio}</p>
      ) : (
        <p className="text-sm text-slate-400 italic">No bio yet.</p>
      )}
    </Card>
    <Card title="Languages">
      <p className="text-sm text-slate-700">{caregiver.languages.join(', ')}</p>
    </Card>
  </>
);

// ─── Helpers ─────────────────────────────────────────────────────
const Card: React.FC<{ title: string; icon?: React.ReactNode; children: React.ReactNode }> = ({ title, icon, children }) => (
  <section className="bg-white border border-slate-200 rounded-2xl p-5">
    <h2 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
      {icon}
      {title}
    </h2>
    {children}
  </section>
);

const ChecklistGrid: React.FC<{ all: string[]; selected: string[] }> = ({ all, selected }) => {
  const sel = new Set(selected.map(s => s.toLowerCase()));
  return (
    <ul className="space-y-1.5 text-sm">
      {all.map(item => {
        const checked = sel.has(item.toLowerCase());
        return (
          <li
            key={item}
            className={`flex items-center gap-2 ${checked ? 'text-slate-800' : 'text-slate-400 line-through decoration-slate-300'}`}
          >
            <CheckCircle className={`w-3.5 h-3.5 flex-shrink-0 ${checked ? 'text-primary-600' : 'text-slate-300'}`} />
            {item}
          </li>
        );
      })}
    </ul>
  );
};

const TrustRow: React.FC<{ show: boolean; icon: React.ReactNode; label: string }> = ({ show, icon, label }) => {
  if (!show) return null;
  return (
    <li className="flex items-center gap-2 text-slate-700">
      {icon}
      {label}
    </li>
  );
};
