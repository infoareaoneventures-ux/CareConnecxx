import React, { useState, useEffect } from 'react';
import { 
  X, MapPin, Star, Clock, Calendar, Phone, Video, 
  CheckCircle, Shield, Award, Briefcase, Activity,
  Car, Utensils, Home, Pill, User, Users,
  ChevronLeft, ChevronRight, Loader2, AlertCircle, ThumbsUp
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { 
  Caregiver, 
  ApprovedMatch, 
  InterviewRequest,
  Appointment,
  CAREGIVER_SKILLS
} from '../../types';
import { dbService } from '../../services/api';
import { db } from '../../lib/firebase';
import { AddToastFunction } from '../../types';

interface CaregiverProfileModalProps {
  caregiver: Caregiver;
  match: ApprovedMatch;
  clientId: string;
  seniorId: string;
  matchAssignmentId?: string;
  interviewStatus: 'not_requested' | 'pending' | 'scheduled' | 'completed';
  canHire: boolean;
  loading?: boolean;
  onClose: () => void;
  onRequestInterview: () => void;
  onHire: () => void;
  onShowToast: AddToastFunction;
}

// Mock work history data - in production this would come from caregiver profile
interface WorkHistoryItem {
  id: string;
  employer: string;
  position: string;
  location: string;
  startDate: string;
  endDate?: string;
  isCurrent: boolean;
  description?: string;
}
interface Review {
  id: string;
  reviewerName: string;
  reviewerPhoto?: string;
  rating: number;
  text: string;
  date: string;
  caregiverName?: string;
}

const MOCK_WORK_HISTORY: WorkHistoryItem[] = [
  {
    id: '1',
    employer: 'Arosa Silicon Valley',
    position: 'Home Care Aide',
    location: 'San Jose, CA',
    startDate: '2022-03',
    isCurrent: true,
    description: 'Provided in-home care for elderly clients with dementia and mobility challenges. Assisted with daily living activities, medication reminders, and companionship.'
  },
  {
    id: '2',
    employer: 'Comfort Keepers',
    position: 'Caregiver',
    location: 'Sunnyvale, CA',
    startDate: '2020-01',
    endDate: '2022-02',
    isCurrent: false,
    description: 'Cared for seniors in their homes. Duties included meal preparation, light housekeeping, transportation to appointments, and personal care assistance.'
  }
];

const SKILL_ICONS: Record<string, React.ElementType> = {
  'Driving & Transportation': Car,
  'Meal Preparation': Utensils,
  'Light Housekeeping': Home,
  'Medication Reminders': Pill,
  'Medical Assistance': User,
  'Companionship': Users,
  'Mobility Support': User,
  'Personal Care': User,
  'Dementia Care': User,
  'Physical Therapy Support': User
};

export const CaregiverProfileModal: React.FC<CaregiverProfileModalProps> = ({
  caregiver,
  match,
  clientId,
  seniorId,
  matchAssignmentId,
  interviewStatus,
  canHire,
  loading = false,
  onClose,
  onRequestInterview,
  onHire,
  onShowToast
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'experience' | 'reviews' | 'calendar'>('overview');
  const [weekOffset, setWeekOffset] = useState(0);
  const [completedAppts, setCompletedAppts] = useState<Appointment[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [similarCaregivers, setSimilarCaregivers] = useState<Caregiver[]>([]);
  const [loadingSimilar, setLoadingSimilar] = useState(false);

  // Load similar caregivers (people also viewed)
  useEffect(() => {
    loadSimilarCaregivers();
  }, [caregiver.id]);

  // Load completed appointments for calendar tab
  useEffect(() => {
    if (!db || !caregiver.id) return;
    let isMounted = true;
    db.collection('appointments')
      .where('caregiverId', '==', caregiver.id)
      .where('status', '==', 'completed')
      .orderBy('isoDate', 'desc')
      .limit(30)
      .get()
      .then(snap => {
        if (!isMounted) return;
        setCompletedAppts(snap.docs.map(d => ({ id: d.id, ...d.data() } as Appointment)));
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, [caregiver.id]);

  // Load reviews
  useEffect(() => {
    if (!db || !caregiver.id) return;
    let isMounted = true;
    setLoadingReviews(true);
    db.collection('reviews')
      .where('caregiverId', '==', caregiver.id)
      .orderBy('rating', 'desc')
      .limit(20)
      .get()
      .then(snap => {
        if (!isMounted) return;
        setReviews(snap.docs.map(d => ({ id: d.id, ...d.data() } as Review)));
      })
      .catch(() => {})
      .finally(() => { if (isMounted) setLoadingReviews(false); });
    return () => { isMounted = false; };
  }, [caregiver.id]);

  const loadSimilarCaregivers = async () => {
    setLoadingSimilar(true);
    try {
      // In production, this would fetch caregivers with similar skills/location
      // For now, we'll use a mock or fetch from available caregivers
      const { caregivers: allCaregivers } = await dbService.getCaregivers();
      const similar = allCaregivers
        .filter(c => c.id !== caregiver.id)
        .slice(0, 3);
      setSimilarCaregivers(similar);
    } catch (error) {
      console.error('Failed to load similar caregivers:', error);
    } finally {
      setLoadingSimilar(false);
    }
  };

  const getBackgroundCheckBadge = () => {
    const status = caregiver.backgroundCheckStatus || caregiver.backgroundCheckData?.status;

    if (status === 'clear' || caregiver.verified) {
      return (
        <Badge variant="success" className="flex items-center gap-1">
          <Shield className="w-3 h-3" />
          Background Cleared
        </Badge>
      );
    }
    return (
      <Badge variant="warning" className="flex items-center gap-1">
        <Clock className="w-3 h-3" />
        Background Check Pending
      </Badge>
    );
  };

  const getVerificationBadges = () => {
    const badges = [];
    
    if (caregiver.verified) {
      badges.push(
        <Badge key="verified" variant="info" className="flex items-center gap-1">
          <CheckCircle className="w-3 h-3" />
          Identity Verified
        </Badge>
      );
    }
    
    if (caregiver.backgroundCheckStatus === 'clear' || caregiver.backgroundCheckData?.status === 'clear' || caregiver.verified) {
      badges.push(
        <Badge key="bg" variant="success" className="flex items-center gap-1">
          <Shield className="w-3 h-3" />
          Background Cleared
        </Badge>
      );
    } else {
      badges.push(
        <Badge key="bg-pending" variant="warning" className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          Background Check Pending
        </Badge>
      );
    }
    
    if (caregiver.certifications && caregiver.certifications.length > 0) {
      badges.push(
        <Badge key="cert" variant="secondary" className="flex items-center gap-1">
          <Award className="w-3 h-3" />
          {caregiver.certifications.length} Certification{caregiver.certifications.length > 1 ? 's' : ''}
        </Badge>
      );
    }
    
    return badges;
  };

  const formatExperience = (years?: number) => {
    if (!years) return 'Experience not specified';
    return `${years} year${years > 1 ? 's' : ''} experience`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header with close button */}
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <h2 className="text-lg font-semibold text-slate-900">Caregiver Profile</h2>
          <div className="flex items-center gap-2">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading...
              </div>
            )}
            <button 
              onClick={onClose}
              className="p-2 hover:bg-slate-100 rounded-full transition-colors"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Profile Header */}
          <div className="p-6">
            <div className="flex gap-4">
              {/* Photo */}
              <div className="w-24 h-24 bg-blue-100 rounded-2xl flex items-center justify-center flex-shrink-0">
                {caregiver?.photo || caregiver?.imageUrl ? (
                  <img 
                    src={caregiver.photo || caregiver.imageUrl} 
                    alt={caregiver.name || 'Caregiver'}
                    className="w-full h-full object-cover rounded-2xl"
                  />
                ) : (
                  <User className="w-12 h-12 text-blue-400" />
                )}
              </div>
              
              {/* Basic Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900">{caregiver?.name || 'Caregiver'}</h1>
                    <p className="text-slate-500 flex items-center gap-1 mt-1">
                      <MapPin className="w-4 h-4" />
                      {caregiver?.location || 'Location not specified'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-blue-600">${caregiver?.hourlyRate || '--'}</p>
                    <p className="text-sm text-slate-500">per hour</p>
                  </div>
                </div>
                
                {/* Verification Badges */}
                <div className="flex flex-wrap gap-2 mt-3">
                  {getVerificationBadges()}
                </div>
                
                {/* Rating */}
                {caregiver?.rating && (
                  <div className="flex items-center gap-2 mt-3">
                    <div className="flex items-center gap-1">
                      <Star className="w-4 h-4 text-accent-500 fill-accent-500" />
                      <span className="font-semibold text-slate-900">{caregiver.rating.toFixed(1)}</span>
                    </div>
                    {caregiver?.reviewCount && (
                      <span className="text-sm text-slate-500">
                        ({caregiver.reviewCount} review{caregiver.reviewCount > 1 ? 's' : ''})
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-slate-200 px-6">
            <div className="flex gap-6">
              {[
                { id: 'overview', label: 'Overview' },
                { id: 'experience', label: 'Experience' },
                { id: 'reviews', label: 'Reviews' },
                { id: 'calendar', label: 'Calendar' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {activeTab === 'overview' && (
              <div className="space-y-6">
                {/* Bio */}
                {caregiver.bio && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-2">
                      About
                    </h3>
                    <p className="text-slate-600 leading-relaxed">{caregiver.bio}</p>
                  </div>
                )}

                {/* Coordinator Notes */}
                {match.coordinatorNotes && (
                  <div className="bg-blue-50 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-blue-900 uppercase tracking-wide mb-2">
                      Why We Recommend {caregiver.name.split(' ')[0]}
                    </h3>
                    <p className="text-blue-800">{match.coordinatorNotes}</p>
                  </div>
                )}

                {/* Services */}
                {caregiver.skills && caregiver.skills.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">
                      Caregiving Services
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      {caregiver.skills.map(skill => {
                        const Icon = SKILL_ICONS[skill] || User;
                        return (
                          <div key={skill} className="flex items-center gap-2 text-slate-700">
                            <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center">
                              <Icon className="w-4 h-4 text-slate-500" />
                            </div>
                            <span className="text-sm">{skill}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Certifications */}
                {caregiver.certifications && caregiver.certifications.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">
                      Certifications
                    </h3>
                    <div className="space-y-2">
                      {caregiver.certifications.map(cert => (
                        <div key={cert} className="flex items-center gap-2 text-slate-700">
                          <Award className="w-4 h-4 text-accent-500" />
                          <span className="text-sm">{cert}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tiered Pricing */}
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">
                    Pricing
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: '1 hr / wk', rate: caregiver.hourlyRate },
                      { label: '3 hrs / wk', rate: Math.round((caregiver.hourlyRate || 25) * 0.94) },
                      { label: '4+ hrs / wk', rate: Math.round((caregiver.hourlyRate || 25) * 0.88) },
                    ].map((tier, i) => (
                      <div key={i} className={`rounded-xl border p-3 text-center ${i === 2 ? 'border-primary-400 bg-primary-50' : 'border-slate-200 bg-white'}`}>
                        {i === 2 && <p className="text-xs font-bold text-primary-600 mb-1">Best Value</p>}
                        <p className="text-lg font-bold text-slate-900">${tier.rate}<span className="text-xs font-normal text-slate-400">/hr</span></p>
                        <p className="text-xs text-slate-500 mt-0.5">{tier.label}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* How to Pay */}
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">
                    How to Pay
                  </h3>
                  {caregiver.paymentPreferences ? (
                    <div className="flex flex-wrap gap-2">
                      {caregiver.paymentPreferences.venmo && (
                        <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-xl">
                          <span className="text-xs font-bold text-blue-700">Venmo</span>
                          <span className="text-xs text-blue-600">{caregiver.paymentPreferences.venmo}</span>
                        </div>
                      )}
                      {caregiver.paymentPreferences.zelle && (
                        <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-xl">
                          <span className="text-xs font-bold text-blue-700">Zelle</span>
                          <span className="text-xs text-blue-600">{caregiver.paymentPreferences.zelle}</span>
                        </div>
                      )}
                      {caregiver.paymentPreferences.cash && (
                        <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-xl">
                          <span className="text-xs font-bold text-green-700">Cash accepted</span>
                        </div>
                      )}
                      {caregiver.paymentPreferences.other && (
                        <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
                          <span className="text-xs text-slate-600">{caregiver.paymentPreferences.other}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">Contact caregiver for payment details</p>
                  )}
                </div>

                {/* Experience Summary */}
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">
                    Experience
                  </h3>
                  <div className="flex items-center gap-2 text-slate-700">
                    <Briefcase className="w-4 h-4 text-slate-500" />
                    <span className="text-sm">{formatExperience(caregiver.experience)}</span>
                  </div>
                  {caregiver.completedJobs && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-primary-50 border border-primary-200 text-primary-700 text-sm font-semibold rounded-full">
                        <CheckCircle className="w-3.5 h-3.5" />
                        {caregiver.completedJobs} bookings completed
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'experience' && (
              <div className="space-y-6">
                {/* Work History */}
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-4">
                    Work History
                  </h3>
                  <div className="space-y-4">
                    {MOCK_WORK_HISTORY.map(job => (
                      <div key={job.id} className="border-l-2 border-slate-200 pl-4 pb-4">
                        <div className="flex items-start justify-between">
                          <div>
                            <h4 className="font-semibold text-slate-900">{job.position}</h4>
                            <p className="text-slate-600">{job.employer}</p>
                            <p className="text-sm text-slate-500 flex items-center gap-1 mt-1">
                              <MapPin className="w-3 h-3" />
                              {job.location}
                            </p>
                          </div>
                          <div className="text-right">
                            <span className="text-sm text-slate-500">
                              {job.startDate} — {job.isCurrent ? 'Present' : job.endDate}
                            </span>
                            {job.isCurrent && (
                              <Badge variant="success" className="ml-2 text-xs">Current</Badge>
                            )}
                          </div>
                        </div>
                        {job.description && (
                          <p className="text-sm text-slate-600 mt-2">{job.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Background Check Details */}
                <div className="bg-slate-50 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">
                    Background Check
                  </h3>
                  {(caregiver.backgroundCheckStatus === 'clear' || caregiver.backgroundCheckData?.status === 'clear') ? (
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                        <Shield className="w-5 h-5 text-green-600" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">Background Check Cleared</p>
                        <p className="text-sm text-slate-600">
                          This caregiver has passed a comprehensive background check including criminal history, 
                          sex offender registry, and identity verification.
                        </p>
                        {caregiver.backgroundCheckData?.completedAt && (
                          <p className="text-xs text-slate-500 mt-2">
                            Completed: {new Date(caregiver.backgroundCheckData.completedAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 bg-accent-100 rounded-full flex items-center justify-center flex-shrink-0">
                        <Clock className="w-5 h-5 text-accent-600" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">Background Check In Progress</p>
                        <p className="text-sm text-slate-600">
                          Background check is currently being processed. You'll be notified when complete.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'reviews' && (
              <div>
                {/* Header */}
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <p className="text-2xl font-bold text-slate-900">
                      {caregiver.rating?.toFixed(1) || '—'}
                    </p>
                    <div className="flex items-center gap-1 mt-0.5">
                      {[...Array(5)].map((_, i) => (
                        <Star key={i} className={`w-3.5 h-3.5 ${i < Math.floor(caregiver.rating || 0) ? 'text-accent-400 fill-accent-400' : 'text-slate-200'}`} />
                      ))}
                      <span className="text-xs text-slate-500 ml-1">
                        {caregiver.reviewCount ? `${caregiver.reviewCount} review${caregiver.reviewCount !== 1 ? 's' : ''}` : 'No reviews yet'}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => onShowToast('Thanks for your recommendation!', 'success')}
                    className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    <ThumbsUp className="w-4 h-4" />
                    Recommend
                  </button>
                </div>

                {/* Reviews list */}
                {loadingReviews ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                  </div>
                ) : reviews.length > 0 ? (
                  <div className="space-y-5">
                    {reviews.map(review => (
                      <div key={review.id} className="border-b border-slate-100 pb-5 last:border-b-0 last:pb-0">
                        <div className="flex items-start gap-3">
                          <img
                            src={review.reviewerPhoto || `https://ui-avatars.com/api/?name=${encodeURIComponent(review.reviewerName)}&background=e2e8f0&color=475569&size=64`}
                            alt={review.reviewerName}
                            className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-semibold text-slate-900 text-sm">{review.reviewerName}</p>
                              <span className="text-xs text-slate-400 flex-shrink-0">
                                {review.date ? new Date(review.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''}
                              </span>
                            </div>
                            <div className="flex items-center gap-0.5 mt-0.5 mb-1.5">
                              {[...Array(5)].map((_, i) => (
                                <Star key={i} className={`w-3 h-3 ${i < review.rating ? 'text-accent-400 fill-accent-400' : 'text-slate-200'}`} />
                              ))}
                            </div>
                            <p className="text-xs text-slate-500 mb-1">
                              Hired {caregiver.name.split(' ')[0]}
                            </p>
                            {review.text && (
                              <p className="text-sm text-slate-700 leading-relaxed">{review.text}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-10">
                    <Star className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                    <p className="text-slate-500 text-sm">No reviews yet.</p>
                    <p className="text-slate-400 text-xs mt-1">Be the first to leave a review after your visit.</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'calendar' && (() => {
              const CAL_HOURS_START = 6;
              const CAL_HOURS_END   = 22;
              const CAL_CELL_H      = 52;
              const CAL_TOTAL_H     = (CAL_HOURS_END - CAL_HOURS_START) * CAL_CELL_H;
              const CAL_DAY_LABELS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
              const CAL_DAY_KEYS    = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
              const CAL_SLOT_RANGES: Record<string, { start: number; end: number }> = {
                morning:   { start: 6,  end: 12 },
                afternoon: { start: 12, end: 18 },
                evening:   { start: 18, end: 22 },
                am: { start: 6,  end: 12 },
                pm: { start: 12, end: 18 },
              };

              const calFmtHour = (h: number) =>
                h === 12 ? '12pm' : h === 0 ? '12am' : h < 12 ? `${h}am` : `${h - 12}pm`;

              const calParseAppt = (t?: string): number => {
                if (!t) return 9;
                const m = t.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i);
                if (!m) return 9;
                let h = parseInt(m[1]);
                const mins = parseInt(m[2] || '0');
                if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
                if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
                return h + mins / 60;
              };

              const today2 = new Date();
              const calStart = new Date(today2);
              calStart.setDate(today2.getDate() - today2.getDay() + weekOffset * 7);

              const calWeekDates = Array.from({ length: 7 }, (_, i) => {
                const d = new Date(calStart);
                d.setDate(calStart.getDate() + i);
                return d;
              });

              const calIsToday = (d: Date) => d.toDateString() === today2.toDateString();

              // Map completed appts to columns
              const calApptsByDay: Record<number, Appointment[]> = {};
              completedAppts.forEach((appt: Appointment) => {
                const ad = new Date(appt.isoDate || appt.date);
                calWeekDates.forEach((wd, idx) => {
                  if (
                    wd.getFullYear() === ad.getFullYear() &&
                    wd.getMonth()    === ad.getMonth()    &&
                    wd.getDate()     === ad.getDate()
                  ) {
                    if (!calApptsByDay[idx]) calApptsByDay[idx] = [];
                    calApptsByDay[idx].push(appt);
                  }
                });
              });

              // Week label
              const calFirst = calWeekDates[0];
              const calLast  = calWeekDates[6];
              const MNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              const calWeekLabel = calFirst.getMonth() === calLast.getMonth()
                ? `${MNAMES[calFirst.getMonth()]} ${calFirst.getDate()} – ${calLast.getDate()}, ${calFirst.getFullYear()}`
                : `${MNAMES[calFirst.getMonth()]} ${calFirst.getDate()} – ${MNAMES[calLast.getMonth()]} ${calLast.getDate()}`;

              const availData: Record<string, string[]> =
                (caregiver as any).weeklyAvailability || {};

              return (
                <div>
                  {/* Toolbar */}
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setWeekOffset(w => w - 1)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors">
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button onClick={() => setWeekOffset(0)} className="px-3 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors">
                        Today
                      </button>
                      <button onClick={() => setWeekOffset(w => w + 1)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors">
                        <ChevronRight className="w-4 h-4" />
                      </button>
                      <span className="text-xs font-medium text-slate-600 ml-1">{calWeekLabel}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-sm bg-primary-50 border border-primary-300 inline-block" />Available
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-sm bg-primary-600 inline-block" />Job Completed
                      </span>
                    </div>
                  </div>

                  {/* Calendar grid */}
                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="overflow-x-auto">
                      <div style={{ minWidth: 480 }}>
                        {/* Day headers */}
                        <div className="grid bg-slate-50 border-b border-slate-200" style={{ gridTemplateColumns: '48px repeat(7, 1fr)' }}>
                          <div className="border-r border-slate-200" />
                          {calWeekDates.map((d, i) => (
                            <div key={i} className={`py-2.5 text-center border-r border-slate-200 last:border-r-0 ${calIsToday(d) ? 'bg-primary-50' : ''}`}>
                              <div className={`text-xs font-bold uppercase tracking-wide ${calIsToday(d) ? 'text-primary-500' : 'text-slate-500'}`}>
                                {CAL_DAY_LABELS[d.getDay()]}
                              </div>
                              <div className={`mx-auto mt-1 w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold ${calIsToday(d) ? 'bg-primary-600 text-white' : 'text-slate-700'}`}>
                                {d.getDate()}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Grid body */}
                        <div className="overflow-y-auto" style={{ maxHeight: 480 }}>
                          <div className="relative" style={{ height: CAL_TOTAL_H }}>
                            {/* Background grid (pointer-events-none) */}
                            <div className="absolute inset-0 pointer-events-none" style={{ display: 'grid', gridTemplateColumns: '48px repeat(7, 1fr)' }}>
                              <div className="border-r border-slate-200">
                                {Array.from({ length: CAL_HOURS_END - CAL_HOURS_START }, (_, i) => i + CAL_HOURS_START).map(h => (
                                  <div key={h} className="border-b border-slate-100 flex items-start justify-end pr-2" style={{ height: CAL_CELL_H, paddingTop: 4 }}>
                                    <span className="text-xs text-slate-400">{calFmtHour(h)}</span>
                                  </div>
                                ))}
                              </div>
                              {Array.from({ length: 7 }).map((_, ci) => (
                                <div key={ci} className="border-r border-slate-200 last:border-r-0">
                                  {Array.from({ length: CAL_HOURS_END - CAL_HOURS_START }).map((__, hi) => (
                                    <div key={hi} className="border-b border-slate-100" style={{ height: CAL_CELL_H }} />
                                  ))}
                                </div>
                              ))}
                            </div>

                            {/* Content columns */}
                            <div className="absolute inset-0" style={{ display: 'grid', gridTemplateColumns: '48px repeat(7, 1fr)' }}>
                              <div /> {/* gutter spacer */}
                              {calWeekDates.map((wd, colIdx) => {
                                const dayKey  = CAL_DAY_KEYS[wd.getDay()];
                                const slots   = (availData[dayKey] || []) as string[];
                                const dayAppts = calApptsByDay[colIdx] || [];

                                // Merge consecutive availability slots
                                const merged: Array<{ start: number; end: number }> = [];
                                slots.forEach((slot: string) => {
                                  const r = CAL_SLOT_RANGES[slot.toLowerCase()];
                                  if (!r) return;
                                  const last = merged[merged.length - 1];
                                  if (last && last.end === r.start) { last.end = r.end; }
                                  else { merged.push({ ...r }); }
                                });

                                return (
                                  <div key={colIdx} className="relative border-r border-slate-200 last:border-r-0">
                                    {/* Availability blocks */}
                                    {merged.map((r, ri) => {
                                      const cs = Math.max(r.start, CAL_HOURS_START);
                                      const ce = Math.min(r.end,   CAL_HOURS_END);
                                      if (ce <= cs) return null;
                                      const top = (cs - CAL_HOURS_START) * CAL_CELL_H;
                                      const ht  = (ce - cs) * CAL_CELL_H;
                                      return (
                                        <div
                                          key={ri}
                                          className="absolute inset-x-0.5 rounded-md bg-primary-50 border border-primary-200 overflow-hidden"
                                          style={{ top: top + 1, height: ht - 2 }}
                                        >
                                          <p className="px-1.5 pt-1 text-xs font-semibold text-primary-700 leading-tight">Available</p>
                                          <p className="px-1.5 text-xs text-primary-500 leading-tight">{calFmtHour(cs)} – {calFmtHour(ce)}</p>
                                        </div>
                                      );
                                    })}
                                    {/* Completed job blocks */}
                                    {dayAppts.map((appt: Appointment, ai: number) => {
                                      const startH = calParseAppt(appt.time);
                                      const dur    = appt.duration || 2;
                                      const cs     = Math.max(startH, CAL_HOURS_START);
                                      const ce     = Math.min(startH + dur, CAL_HOURS_END);
                                      if (ce <= cs) return null;
                                      const top = (cs - CAL_HOURS_START) * CAL_CELL_H;
                                      const ht  = (ce - cs) * CAL_CELL_H;
                                      return (
                                        <div
                                          key={ai}
                                          className="absolute inset-x-0.5 rounded-md bg-primary-600 border border-primary-700 overflow-hidden z-10"
                                          style={{ top: top + 1, height: ht - 2 }}
                                        >
                                          <p className="px-1.5 pt-1 text-xs font-bold text-white leading-tight">Job Completed</p>
                                          <p className="px-1.5 text-xs text-primary-100 leading-tight">{appt.time} – {calFmtHour(Math.min(startH + dur, CAL_HOURS_END))}</p>
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-400 mt-3 text-center">
                    {caregiver.name.split(' ')[0]}'s typical weekly availability · completed jobs shown in teal
                  </p>
                </div>
              );
            })()}
          </div>

          {/* People Also Viewed */}
          {similarCaregivers.length > 0 && (
            <div className="border-t border-slate-200 p-6">
              <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-4">
                People Also Viewed
              </h3>
              <div className="space-y-3">
                {similarCaregivers.map(similar => (
                  <div 
                    key={similar.id}
                    className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors cursor-pointer"
                  >
                    <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                      <User className="w-6 h-6 text-blue-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-900 truncate">{similar.name}</p>
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        {similar.rating && (
                          <span className="flex items-center gap-1">
                            <Star className="w-3 h-3 text-accent-500 fill-accent-500" />
                            {similar.rating.toFixed(1)}
                          </span>
                        )}
                        <span>•</span>
                        <span>${similar.hourlyRate}/hr</span>
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-slate-400" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons Footer */}
        <div className="border-t border-slate-200 p-4 bg-slate-50">
          <div className="flex gap-3">
            {interviewStatus === 'not_requested' && (
              <Button 
                fullWidth
                variant="outline"
                onClick={onRequestInterview}
                className="flex-1"
              >
                <Calendar className="w-4 h-4 mr-2" />
                Request Interview
              </Button>
            )}
            
            {interviewStatus === 'completed' && canHire && (
              <Button 
                fullWidth
                onClick={onHire}
                className="flex-1"
              >
                <Activity className="w-4 h-4 mr-2" />
                Hire {caregiver.name.split(' ')[0]}
              </Button>
            )}
            
            {interviewStatus === 'pending' && (
              <Button 
                fullWidth
                variant="secondary"
                disabled
                className="flex-1"
              >
                <Clock className="w-4 h-4 mr-2" />
                Interview Pending
              </Button>
            )}
            
            {interviewStatus === 'scheduled' && (
              <Button 
                fullWidth
                variant="secondary"
                disabled
                className="flex-1"
              >
                <Calendar className="w-4 h-4 mr-2" />
                Interview Scheduled
              </Button>
            )}
          </div>
          
          {/* Status message */}
          {interviewStatus === 'not_requested' && (
            <p className="text-xs text-slate-500 text-center mt-2">
              Interview {canHire ? 'or hire' : ''} to proceed
            </p>
          )}
          {!canHire && interviewStatus !== 'not_requested' && (
            <p className="text-xs text-slate-500 text-center mt-2">
              Complete at least 2 interviews before hiring
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
