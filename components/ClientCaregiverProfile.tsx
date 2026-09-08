import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  Star, MapPin, CheckCircle, ChevronLeft, Car,
  MessageSquare, Video, Languages, GraduationCap, RefreshCw,
} from 'lucide-react';
import { CaregiverVerificationBadges } from './shared/CaregiverVerificationBadges';
import { ScheduleInterviewModal } from './ScheduleInterviewModal';
import { auth, db } from '../lib/firebase';
import { useAccessGates } from '../hooks/useAccessGates';
import { useCareConnex } from '../context/CareConnexContext';
import { dbService } from '../services/api';
import { hasValidTransportDocs } from '../utils/transportDocs';
import { ClientNavigation } from './client/ClientNavigation';
import { LeaveReviewModal } from './client/LeaveReviewModal';
import { TIME_BLOCKS, DAYS } from './caregiver/signup/constants';
import { weeklySlotsToBl } from '../services/availabilityService';

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
  city: string;
  distance: number;
  experience: string;
  bio: string;
  languages: string[];
  skills: string[];
  education?: string;
  verified: boolean;
  backgroundCheckStatus?: string;
  hasTransportation: boolean;
  serviceRadius: number;
  weeklyAvailability: Record<string, string[]>;
  jobTypes: string[];
  lastActiveIso?: string;
}

type Review = { id: string; reviewerName: string; reviewerPhoto?: string | null; rating: number; comment: string; dateIso: string; wouldRecommend?: boolean | null };


function mapRawToProfile(id: string, data: any): CaregiverProfile {
  const firstName = data.firstName || data.name?.split(' ')[0] || 'Caregiver';
  const lastName = data.lastName || data.name?.split(' ').slice(1).join(' ') || '';
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
    rateFor2Seniors: data.rateFor2Seniors || data.rateForTwo,
    rateFor3Seniors: data.rateFor3PlusSeniors || data.rateFor3Seniors || data.rateForThree,
    city: data.city || data.location || 'Nearby',
    distance: data.distance ?? 0,
    experience: data.yearsExperience || String(data.experience || ''),
    bio: data.bio || data.about || '',
    languages: data.languages || ['English'],
    skills: data.skills || data.services || data.specializations || [],
    education: data.education,
    verified: data.verified || false,
    backgroundCheckStatus: data.backgroundCheckStatus,
    hasTransportation: hasValidTransportDocs(data),
    serviceRadius: data.serviceRadius ?? 25,
    weeklyAvailability: weeklySlotsToBl(data.weeklyAvailability || {}),
    jobTypes: data.jobTypes || [],
    lastActiveIso: data.lastActive || data.lastActiveIso,
  };
}

interface ClientCaregiverProfileProps {
  modalMode?: boolean;
  overrideId?: string;
  overrideData?: any;
  onClose?: () => void;
}

export default function ClientCaregiverProfile({
  modalMode,
  overrideId,
  overrideData,
  onClose,
}: ClientCaregiverProfileProps = {}) {
  const navigate = useNavigate();
  const { caregiverId: routeCaregiverId } = useParams();
  const location = useLocation();
  const caregiverId = overrideId || routeCaregiverId;
  const passedData = overrideData || (location.state as any)?.caregiverData;
  const [caregiver, setCaregiver] = useState<CaregiverProfile | null>(
    passedData && caregiverId ? mapRawToProfile(caregiverId, passedData) : null
  );
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(!passedData);
  const [showInterviewModal, setShowInterviewModal] = useState(false);
  const [clientOpenPosts, setClientOpenPosts] = useState<{ id: string; title: string; createdAt?: string }[]>([]);
  const [isBooked, setIsBooked] = useState(false);
  const [hasPastBooking, setHasPastBooking] = useState(false);
  const [hasCompletedInterview, setHasCompletedInterview] = useState(false);
  const [isRequested, setIsRequested] = useState(false);
  const [hasCompletedShift, setHasCompletedShift] = useState(false);
  const [hasReviewed, setHasReviewed] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [showAllReviews, setShowAllReviews] = useState(false);
  const { gate, Modals: GateModals } = useAccessGates();
  const { addToast } = useCareConnex();

  useEffect(() => {
    if (!caregiverId) return;
    // When opened from a list that already loaded the full publicCaregiverProfiles
    // doc (the modal path — see FindCaregivers.tsx's viewingCaregiver), skip the
    // refetch entirely. It was re-reading the exact same doc and merging users/{uid}
    // on top, which can carry slightly different values for overlapping fields
    // (photoURL, verified, backgroundCheckStatus) — the profile would render
    // instantly with the passed data, then visibly flash to the refetched version
    // moments later even though nothing meaningful had changed.
    if (!passedData) fetchCaregiverProfile(caregiverId);
    fetchReviews(caregiverId);
    const uid = auth!.currentUser?.uid;
    if (uid) {
      dbService.getJobPostsByClient(uid).then(posts => {
        setClientOpenPosts(posts.filter((p: any) => p.status === 'open').map((p: any) => ({ id: p.id, title: p.title, startDate: p.startDate || p.date, createdAt: p.createdAt })));
      }).catch(() => {});

      // Check for an existing accepted booking with this caregiver that STILL
      // has a live shift. booking_requests.status stays 'accepted' forever
      // once accepted, so that field alone can't tell "ongoing" from "long
      // over" — same rule ClientDashboard.tsx and MyCareTeam.tsx already use.
      db!.collection('booking_requests')
        .where('clientId', '==', uid)
        .where('caregiverId', '==', caregiverId)
        .where('status', '==', 'accepted')
        .get()
        .then(async snap => {
          if (snap.empty) { setIsBooked(false); setHasPastBooking(false); return; }
          setHasPastBooking(true);
          const bookingIds = snap.docs.map(d => d.id);
          const shiftsSnap = await db!.collection('shifts')
            .where('clientId', '==', uid)
            .where('status', 'in', ['scheduled', 'in-progress'])
            .get();
          const hasLiveShift = shiftsSnap.docs.some(d => bookingIds.includes(d.data().bookingRequestId));
          setIsBooked(hasLiveShift);
        })
        .catch(() => {});

      // Check for an active interview request with this caregiver, and
      // whether a PAST interview with them was completed — same rule
      // MyCareTeam.tsx uses to decide whether the Past tab offers Re-book
      // (a family that's already interviewed this caregiver shouldn't be
      // asked to "Request Interview" again once their booking ends).
      const activeStatuses = ['requested', 'pending', 'scheduled'];
      db!.collection('video_interviews')
        .where('clientId', '==', uid)
        .where('caregiverId', '==', caregiverId)
        .get()
        .then(snap => {
          const hasActive = snap.docs.some(d => activeStatuses.includes(d.data().status));
          setIsRequested(hasActive);
          setHasCompletedInterview(snap.docs.some(d => d.data().status === 'completed'));
        })
        .catch(() => {});

      // Check for a completed shift with this caregiver
      db!.collection('shifts')
        .where('clientId', '==', uid)
        .where('caregiverId', '==', caregiverId)
        .where('status', '==', 'completed')
        .limit(1)
        .get()
        .then(snap => setHasCompletedShift(!snap.empty))
        .catch(() => {});

      // Check if the client has already left a review for this caregiver
      db!.collection('reviews')
        .where('clientId', '==', uid)
        .where('caregiverId', '==', caregiverId)
        .limit(1)
        .get()
        .then(snap => setHasReviewed(!snap.empty))
        .catch(() => {});
    }
  }, [caregiverId]);

  const fetchCaregiverProfile = async (id: string) => {
    try {
      const [userSnap, cgSnap] = await Promise.all([
        db!.collection('users').doc(id).get().catch(() => null),
        db!.collection('publicCaregiverProfiles').doc(id).get().catch(() => null),
      ]);
      if (!userSnap?.exists && !cgSnap?.exists) {
        if (!passedData) setCaregiver(null);
        return;
      }
      const data: any = { ...(cgSnap?.data() || {}), ...(userSnap?.data() || {}) };
      setCaregiver(mapRawToProfile(id, data));
    } catch {
      if (!passedData) setCaregiver(null);
    } finally {
      setLoading(false);
    }
  };

  const fetchReviews = async (id: string) => {
    try {
      const snap = await db!.collection('reviews')
        .where('caregiverId', '==', id)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();
      setReviews(snap.docs.map(d => {
        const r: any = d.data();
        return {
          id: d.id,
          reviewerName: r.clientName || 'A client',
          reviewerPhoto: r.clientPhotoURL || null,
          rating: r.rating || 5,
          comment: r.comment || r.feedback || '',
          dateIso: r.date || r.createdAt || new Date().toISOString(),
          wouldRecommend: r.wouldRecommend ?? null,
          categories: r.categories || null,
        };
      }));
    } catch {
      setReviews([]);
    }
  };

  const fullName = caregiver ? `${caregiver.firstName} ${caregiver.lastName}`.trim() : '';

  const handleMessage = () => {
    if (!caregiver) return;
    gate('message', fullName, () => {
      const uid = auth!.currentUser?.uid;
      if (!uid) { navigate('/client/inbox'); return; }
      const clientName = auth!.currentUser?.displayName || auth!.currentUser?.email?.split('@')[0] || 'Client';
      const sorted = [uid, caregiver.id].sort();
      const roomId = sorted.join('_');
      const names = sorted.map(id => id === uid ? clientName : fullName);
      const avatars = sorted.map(id => id === uid ? '' : ((caregiver as any).imageUrl || (caregiver as any).photo || ''));
      navigate(`/client/inbox?room=${roomId}`, {
        state: {
          pendingRoom: {
            id: roomId, participants: sorted, participantNames: names, participantAvatars: avatars,
            unreadCount: { [uid]: 0, [caregiver.id]: 0 },
            lastMessage: '', lastMessageTime: '', lastMessageTimestamp: null, createdAt: null,
          }
        }
      });
    });
  };

  const handleInterview = () => {
    if (!caregiver) return;
    gate('interview', fullName, () => setShowInterviewModal(true));
  };

  if (loading) return (
    <div className={modalMode ? 'flex items-center justify-center py-20' : 'min-h-screen bg-slate-50'}>
      {!modalMode && <ClientNavigation />}
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    </div>
  );

  if (!caregiver) return (
    <div className={modalMode ? 'py-16 text-center' : 'min-h-screen bg-slate-50'}>
      {!modalMode && <ClientNavigation />}
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <p className="text-slate-500 mb-4">Caregiver not found.</p>
        <button onClick={onClose ?? (() => navigate('/client/find-caregivers'))} className="px-5 py-2 bg-primary-600 text-white rounded-full font-semibold">
          {onClose ? 'Close' : 'Back to search'}
        </button>
      </div>
    </div>
  );

  const hasAvailability = Object.values(caregiver.weeklyAvailability).some(slots => slots.length > 0);

  return (
    <div className={modalMode ? 'bg-slate-50' : 'min-h-screen bg-slate-50 pb-24'}>
      {!modalMode && <ClientNavigation />}

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        {!modalMode && (
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-4"
          >
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
        )}

        {/* Hero card */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-5">
          <div className="bg-gradient-to-r from-primary-500 to-primary-600 h-20" />
          <div className="px-6 pb-5">
            <div className="flex items-start justify-between">
              {/* Left: avatar + info */}
              <div className="flex-1 min-w-0">
                <div className="-mt-10 mb-3">
                  <div className="w-20 h-20 rounded-full border-4 border-white bg-slate-200 overflow-hidden shadow-md flex-shrink-0 flex items-center justify-center text-slate-400 text-xl font-bold">
                    {caregiver.photo
                      ? <img src={caregiver.photo} alt={fullName} className="w-full h-full object-cover" />
                      : `${caregiver.firstName.charAt(0)}${caregiver.lastName.charAt(0)}`
                    }
                  </div>
                </div>

                <h1 className="text-2xl font-bold text-slate-900 mb-1">{fullName}</h1>

                {/* Star rating */}
                <div className="flex items-center gap-1 mb-2">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={`w-4 h-4 ${caregiver.reviewCount > 0 && i < Math.round(caregiver.rating) ? 'text-accent-400' : 'text-slate-200'}`}
                      fill="currentColor"
                    />
                  ))}
                  {caregiver.reviewCount > 0
                    ? <span className="text-sm font-medium text-slate-700 ml-1">{caregiver.rating.toFixed(1)} ({caregiver.reviewCount} review{caregiver.reviewCount !== 1 ? 's' : ''})</span>
                    : <span className="text-sm text-slate-400 ml-1">No reviews yet</span>
                  }
                </div>

                {/* Badges */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <CaregiverVerificationBadges
                    verified={caregiver.verified}
                    backgroundCheckStatus={caregiver.backgroundCheckStatus}
                  />
                  {caregiver.hasTransportation && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-1 rounded-full">
                      <Car className="w-3.5 h-3.5" /> Transportation
                    </span>
                  )}
                </div>

                {/* Location / rate */}
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                  {caregiver.city && (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3.5 h-3.5" />
                      {caregiver.city}{caregiver.distance > 0 ? ` · ${caregiver.distance} miles away` : ''}
                    </span>
                  )}
                  {caregiver.hourlyRate > 0 && (
                    <span className="font-semibold text-slate-800">${caregiver.hourlyRate}/hr</span>
                  )}
                </div>
              </div>

              {/* Right: action buttons */}
              <div className="flex flex-col gap-2 mt-2 ml-4 flex-shrink-0 w-44">
                {isBooked ? (
                  <div className="w-full py-2.5 bg-green-50 border border-green-200 text-green-700 font-semibold rounded-full flex items-center justify-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4" /> Active Booking
                  </div>
                ) : hasPastBooking && hasCompletedInterview ? (
                  <button
                    onClick={() => navigate(`/client/posts?rebook=${caregiverId}`)}
                    className="w-full py-2.5 border border-primary-300 text-primary-700 font-semibold rounded-full hover:bg-primary-50 transition-colors flex items-center justify-center gap-2 text-sm"
                  >
                    <RefreshCw className="w-4 h-4" /> Re-book
                  </button>
                ) : isRequested ? (
                  <div className="w-full py-2.5 bg-slate-100 border border-slate-200 text-slate-500 font-semibold rounded-full flex items-center justify-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4" /> Interview Requested
                  </div>
                ) : (
                  <button
                    onClick={handleInterview}
                    className="w-full py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors flex items-center justify-center gap-2 text-sm"
                  >
                    <Video className="w-4 h-4" /> Request Interview
                  </button>
                )}
                <button
                  onClick={handleMessage}
                  className="w-full py-2.5 border border-slate-200 text-slate-700 font-semibold rounded-full hover:bg-slate-50 transition-colors flex items-center justify-center gap-2 text-sm"
                >
                  <MessageSquare className="w-4 h-4" /> Message
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:flex lg:gap-5">
          {/* Main scroll */}
          <div className="flex-1 space-y-4">

            {/* About */}
            <Section title={`About ${caregiver.firstName}`}>
              {caregiver.bio
                ? <p className="text-sm text-slate-700 leading-relaxed break-all">{caregiver.bio}</p>
                : <p className="text-sm text-slate-400 italic">No bio yet.</p>
              }
              {caregiver.languages.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-slate-600 mt-3">
                  <Languages className="w-4 h-4 text-slate-400" />
                  <span className="font-medium">Languages:</span>
                  <span>{caregiver.languages.join(', ')}</span>
                </div>
              )}
            </Section>

            {/* Care Services — Transportation only shown when badge is earned */}
            {caregiver.skills.length > 0 && (
              <Section title="Care Services">
                <div className="flex flex-wrap gap-2">
                  {caregiver.skills.filter(s => s !== 'Transportation' || caregiver.hasTransportation).map(s => (
                    <span key={s} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-medium">
                      <CheckCircle className="w-3 h-3" /> {s}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {/* Rates */}
            <Section title="Rates">
              <div className="divide-y divide-slate-100">
                {[
                  { label: '1 Person', rate: caregiver.hourlyRate },
                  { label: '2 People', rate: caregiver.rateFor2Seniors },
                  { label: '3+ People', rate: caregiver.rateFor3Seniors },
                ].filter(r => r.rate && Number(r.rate) > 0).map(({ label, rate }) => (
                  <div key={label} className="flex items-center justify-between py-2.5">
                    <span className="text-sm text-slate-600">{label}</span>
                    <span className="text-sm font-bold text-slate-900">${rate}/hr</span>
                  </div>
                ))}
                {caregiver.experience && (
                  <div className="pt-2.5 text-xs text-slate-500">{caregiver.experience} experience</div>
                )}
              </div>
            </Section>

            {/* Weekly Availability */}
            {hasAvailability && (
              <Section title="Weekly Availability">
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full min-w-[380px]">
                    <thead>
                      <tr>
                        <th className="w-28" />
                        {DAYS.map(d => (
                          <th key={d.id} className="text-xs font-semibold text-slate-500 text-center pb-2">
                            {d.id.slice(0, 1).toUpperCase() + d.id.slice(1, 3)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {TIME_BLOCKS.map(block => (
                        <tr key={block.id}>
                          <td className="py-1 pr-2">
                            <div>
                              <p className="text-sm font-medium text-slate-600">{block.label}</p>
                              <p className="text-xs text-slate-400">{block.time}</p>
                            </div>
                          </td>
                          {DAYS.map(d => {
                            const on = (caregiver.weeklyAvailability[d.id] || []).includes(block.id);
                            return (
                              <td key={d.id} className="py-1 text-center">
                                <div className={`w-8 h-8 rounded-xl mx-auto ${on ? 'bg-primary-500' : 'bg-slate-100'}`} />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}

            {/* Background */}
            {caregiver.education && (
              <Section title="Background">
                <div className="flex items-start gap-2 text-sm text-slate-700">
                  <GraduationCap className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                  <span>{caregiver.education}</span>
                </div>
              </Section>
            )}

            {/* Location */}
            <Section title="Location & Travel">
              <div className="space-y-1.5 text-sm text-slate-700">
                {caregiver.city && (
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-primary-500 flex-shrink-0" />
                    Lives in {caregiver.city}
                  </div>
                )}
                <div className="flex items-center gap-2 text-slate-500">
                  <MapPin className="w-4 h-4 text-slate-300 flex-shrink-0" />
                  Willing to travel within {caregiver.serviceRadius} miles
                </div>
              </div>
            </Section>

            {/* Reviews */}
            <Section
              title={`Reviews${caregiver.reviewCount > 0 ? ` (${caregiver.reviewCount})` : ''}`}
              action={
                hasCompletedShift && !hasReviewed ? (
                  <button onClick={() => setShowReviewModal(true)}
                    className="px-3 py-1.5 border border-primary-200 text-primary-600 font-semibold text-xs rounded-full hover:bg-primary-50 transition-colors flex items-center gap-1">
                    <Star className="w-3 h-3" /> Leave a Review
                  </button>
                ) : hasReviewed ? (
                  <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                    <CheckCircle className="w-3.5 h-3.5" /> Reviewed
                  </span>
                ) : undefined
              }>

              {reviews.length > 0 && (() => {
                const withAnswer = reviews.filter(r => r.wouldRecommend !== null && r.wouldRecommend !== undefined);
                const pct = withAnswer.length > 0 ? Math.round((withAnswer.filter(r => r.wouldRecommend).length / withAnswer.length) * 100) : null;
                const catKeys = ['punctuality','professionalism','communication','careQuality'] as const;
                const catLabels: Record<string, string> = { punctuality:'Punctuality', professionalism:'Professionalism', communication:'Communication', careQuality:'Quality of Care' };
                const catAvgs = catKeys.map(k => {
                  const vals = reviews.map(r => (r as any).categories?.[k]).filter((v: any) => v > 0);
                  return { key: k, label: catLabels[k], avg: vals.length > 0 ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : null };
                }).filter(c => c.avg !== null);
                const overallAvg = reviews.length > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : null;
                if (!pct && catAvgs.length === 0 && overallAvg === null) return null;
                return (
                  <div className="mb-4 pb-4 border-b border-slate-100 space-y-2">
                    {overallAvg !== null && (
                      <div className="flex items-center gap-2">
                        <div className="flex gap-0.5">
                          {[1,2,3,4,5].map(s => (
                            <Star key={s} className={`w-4 h-4 ${s <= Math.round(overallAvg) ? 'fill-yellow-400 text-yellow-400' : 'text-slate-200 fill-current'}`} />
                          ))}
                        </div>
                        <span className="text-sm font-semibold text-slate-700">{overallAvg.toFixed(1)}</span>
                        <span className="text-xs text-slate-400">overall ({reviews.length} {reviews.length === 1 ? 'review' : 'reviews'})</span>
                      </div>
                    )}
                    {pct !== null && (
                      <p className="text-xs text-slate-500">
                        <span className="font-semibold text-green-600">{pct}%</span> of clients would recommend
                      </p>
                    )}
                    {catAvgs.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        {catAvgs.map(c => (
                          <div key={c.key} className="flex items-center gap-3">
                            <span className="text-xs text-slate-500 w-32 shrink-0">{c.label}</span>
                            <div className="flex gap-0.5">
                              {[1,2,3,4,5].map(s => (
                                <Star key={s} className={`w-3 h-3 ${s <= Math.round(c.avg!) ? 'fill-yellow-400 text-yellow-400' : 'text-slate-200 fill-current'}`} />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              {reviews.length === 0 ? (
                <div className="text-center py-6">
                  <Star className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                  <p className="text-sm text-slate-400">No reviews yet.</p>
                </div>
              ) : (
                <div>
                  <div className="divide-y divide-slate-100">
                    {(showAllReviews ? reviews : reviews.slice(0, 3)).map(r => (
                      <div key={r.id} className="py-3 first:pt-0 last:pb-0 flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary-100 overflow-hidden flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                          {r.reviewerPhoto
                            ? <img src={r.reviewerPhoto} alt={r.reviewerName} className="w-full h-full object-cover" />
                            : (r.reviewerName || 'C').charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <p className="text-sm font-semibold text-slate-900">{r.reviewerName}</p>
                            <span className="text-xs text-slate-400">{new Date(r.dateIso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>
                          </div>
                          <div className="flex gap-0.5 mb-1">
                            {[...Array(5)].map((_, i) => (
                              <Star key={i} className={`w-3.5 h-3.5 ${i < r.rating ? 'text-accent-400 fill-current' : 'text-slate-200 fill-current'}`} />
                            ))}
                          </div>
                          {r.comment && <p className="text-sm text-slate-600 leading-relaxed">{r.comment}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {reviews.length > 3 && (
                    <button onClick={() => setShowAllReviews(v => !v)}
                      className="mt-3 text-sm text-primary-600 font-semibold hover:text-primary-700 transition-colors">
                      {showAllReviews ? 'Show less' : `See all ${reviews.length} reviews`}
                    </button>
                  )}
                </div>
              )}
            </Section>

          </div>

        </div>
      </main>

      <GateModals />

      {showReviewModal && caregiver && (
        <LeaveReviewModal
          caregiverId={caregiver.id}
          caregiverName={`${caregiver.firstName} ${caregiver.lastName}`.trim()}
          onClose={() => setShowReviewModal(false)}
          onSubmitted={() => {
            setHasReviewed(true);
            fetchReviews(caregiver.id);
          }}
        />
      )}

      {showInterviewModal && caregiver && (
        <ScheduleInterviewModal
          caregiver={{
            id: caregiver.id,
            name: fullName,
            imageUrl: caregiver.photo,
            hourlyRate: caregiver.hourlyRate,
            rating: caregiver.rating,
            distance: caregiver.distance,
            skills: caregiver.skills,
            availability: [],
            experience: Number(caregiver.experience) || 0,
          } as any}
          jobPosts={clientOpenPosts}
          onClose={() => setShowInterviewModal(false)}
          onSuccess={(msg) => {
            addToast(msg, 'success');
            setIsRequested(true);
            setShowInterviewModal(false);
          }}
          onShowToast={(msg, type) => addToast(msg, type)}
        />
      )}
    </div>
  );
}

const Section: React.FC<{ title: string; children: React.ReactNode; action?: React.ReactNode }> = ({ title, children, action }) => (
  <div className="bg-white border border-slate-200 rounded-2xl p-5">
    <div className="flex items-center justify-between mb-3">
      <h2 className="font-bold text-slate-900">{title}</h2>
      {action}
    </div>
    {children}
  </div>
);

