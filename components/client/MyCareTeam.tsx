import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Calendar, Clock, Shield, Heart, MessageSquare, User, Search, RefreshCw } from 'lucide-react';
import { CaregiverVerificationBadges } from '../shared/CaregiverVerificationBadges';
import { Button } from '../ui/Button';
import { ClientNavigation } from './ClientNavigation';
import { useCareConnex } from '../../context/CareConnexContext';
import { db } from '../../lib/firebase';
import { authService } from '../../services/api';
import { IdentityGateModal } from './IdentityGateModal';
import { chatService } from '../../services/chatService';

interface TeamCaregiver {
  id: string;
  bookingId: string;
  bookingStatus: string;
  name: string;
  imageUrl?: string;
  rating: number;
  yearsExperience: number;
  hourlyRate: number;
  bookingRate?: number | null;
  isTopRated?: boolean;
  specialties?: string[];
  location?: string;
  scheduleDays?: string[];
  nextShift?: string;
  careRecipients?: Array<{ firstName?: string; lastName?: string; name?: string; [key: string]: any }>;
  verified?: boolean;
  backgroundCheckStatus?: string;
}


export const MyCareTeam: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();
  const [activeTab, setActiveTab] = useState<'active' | 'past'>('active');
  const [query, setQuery] = useState('');
  const [activeCaregivers, setActiveCaregivers] = useState<TeamCaregiver[]>([]);
  const [pastCaregivers, setPastCaregivers] = useState<TeamCaregiver[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showIdentityGate, setShowIdentityGate] = useState(false);
  const [identityStatus, setIdentityStatus] = useState<string>('not_started');

  useEffect(() => {
    let isMounted = true;
    const loadTeam = async () => {
      try {
        const uid = authService.getCurrentUser()?.uid;
        if (!uid) { setIsLoading(false); return; }

        // Query booking_requests + scheduled shifts in parallel
        const [allBookingsSnap, scheduledShiftsSnap] = await Promise.all([
          db.collection('booking_requests')
            .where('clientId', '==', uid)
            .limit(100)
            .get(),
          db.collection('shifts')
            .where('clientId', '==', uid)
            .where('status', '==', 'scheduled')
            .get(),
        ]);

        // Build set of booking IDs that still have scheduled shifts
        const activeBookingIds = new Set<string>();
        scheduledShiftsSnap.docs.forEach(d => {
          const bid = d.data().bookingRequestId;
          if (bid) activeBookingIds.add(bid);
        });

        // Active = accepted AND has scheduled shifts
        // Past = cancelled/completed OR accepted with no scheduled shifts left
        const activeDocs = allBookingsSnap.docs.filter(d =>
          d.data().status === 'accepted' && activeBookingIds.has(d.id)
        );
        const pastDocs = allBookingsSnap.docs.filter(d =>
          ['cancelled', 'completed'].includes(d.data().status) ||
          (d.data().status === 'accepted' && !activeBookingIds.has(d.id))
        );

        const buildCaregiverList = async (
          docs: any[],
        ): Promise<TeamCaregiver[]> => {
          // Deduplicate by caregiverId (keep first/most-recent booking per caregiver)
          const seenCaregivers = new Map<string, { bookingId: string; bookingData: any }>();
          docs.forEach(doc => {
            const d = doc.data();
            if (d.caregiverId && !seenCaregivers.has(d.caregiverId)) {
              seenCaregivers.set(d.caregiverId, { bookingId: doc.id, bookingData: d });
            }
          });

          const list: TeamCaregiver[] = [];
          for (const [cgId, { bookingId, bookingData }] of seenCaregivers) {
            // Fetch full caregiver profile for extra details
            const cgDoc = await db.collection('caregivers').doc(cgId).get().catch(() => null);
            const cgData = cgDoc?.data() || {};

            const fullName =
              bookingData.caregiverName ||
              cgData.name ||
              `${cgData.firstName || ''} ${cgData.lastName || ''}`.trim() ||
              'Caregiver';

            const imageUrl =
              bookingData.caregiverPhotoURL ||
              cgData.photoURL ||
              cgData.photo ||
              cgData.profilePhoto ||
              cgData.imageUrl;

            const scheduleDays: string[] = (() => {
              const dst = bookingData.schedule?.dayShiftTimes;
              if (dst && typeof dst === 'object') return Object.keys(dst);
              return bookingData.schedule?.days || [];
            })();

            // Compute next shift — shows "In progress", "Today", or next date
            const nextShift: string | undefined = (() => {
              if (!scheduleDays.length) return undefined;
              const ALL_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
              const normDay = (d: string) =>
                d.trim().charAt(0).toUpperCase() + d.trim().slice(1, 3).toLowerCase();
              const now = new Date();
              const todayNorm = ALL_DAYS[now.getDay()];
              const normalizedDays = scheduleDays.map(normDay);

              if (normalizedDays.includes(todayNorm)) {
                // Check if a shift block is currently in progress
                const todayBlocks: Array<{ start: string; end: string }> =
                  bookingData.schedule?.dayShiftTimes?.[todayNorm] || [];
                const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                const inProgress = todayBlocks.some(b => b.start && b.end && hhmm >= b.start && hhmm <= b.end);
                return inProgress ? 'In progress' : 'Today';
              }

              // Find the nearest upcoming scheduled day
              let earliest: Date | null = null;
              scheduleDays.forEach(day => {
                const target = ALL_DAYS.indexOf(normDay(day));
                if (target === -1) return;
                const diff = (target - now.getDay() + 7) % 7 || 7;
                const next = new Date(now);
                next.setDate(now.getDate() + diff);
                if (!earliest || next < earliest) earliest = next;
              });
              if (!earliest) return undefined;
              return (earliest as Date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            })();

            const city = cgData.city || '';
            const state = cgData.state || '';

            list.push({
              id: cgId,
              bookingId,
              bookingStatus: bookingData.status,
              name: fullName,
              imageUrl,
              rating: cgData.rating ?? 0,
              yearsExperience: cgData.yearsExperience ?? 0,
              hourlyRate: cgData.hourlyRate ?? 0,
              bookingRate: bookingData.rate ?? null,
              isTopRated: (cgData.rating ?? 0) >= 4.8,
              specialties: cgData.specializations || cgData.specialties || [],
              location: city ? `${city}${state ? `, ${state}` : ''}` : (cgData.location || ''),
              scheduleDays,
              nextShift,
              careRecipients: bookingData.careRecipients || [],
              verified: cgData.verificationStatus === 'approved' || cgData.verificationStatus === 'checkr_clear',
              backgroundCheckStatus: cgData.verificationStatus,
            });
          }
          return list;
        };

        const [activeList, pastList] = await Promise.all([
          buildCaregiverList(activeDocs),
          buildCaregiverList(pastDocs),
        ]);

        if (!isMounted) return;
        setActiveCaregivers(activeList);
        setPastCaregivers(pastList);
      } catch (err: any) {
        console.error('MyCareTeam: error loading care team:', err?.message || err);
        if (isMounted) addToast(`Could not load your care team: ${err?.message || 'unknown error'}`, 'error');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    loadTeam();
    return () => { isMounted = false; };
  }, []);

  // Load identity check status
  useEffect(() => {
    const uid = authService.getCurrentUser()?.uid;
    if (!uid || !db) return;
    let isMounted = true;
    db.collection('users').doc(uid).get()
      .then(doc => {
        if (!isMounted) return;
        setIdentityStatus((doc.data() as any)?.identityCheckStatus || 'not_started');
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, []);

  const bypass = import.meta.env.VITE_BYPASS_ONBOARDING === 'true';

  const handleMessage = async (caregiverId: string, caregiverName: string) => {
    if (!bypass && identityStatus !== 'verified') {
      setShowIdentityGate(true);
      return;
    }
    try {
      const currentUid = authService.getCurrentUser()?.uid;
      const currentName =
        authService.getCurrentUser()?.displayName ||
        authService.getCurrentUser()?.email?.split('@')[0] ||
        'Client';
      if (currentUid) {
        const roomId = await chatService.getOrCreateChatRoom(currentUid, currentName, caregiverId, caregiverName);
        navigate(`/client/inbox?room=${roomId}`);
      } else {
        navigate('/client/inbox');
      }
    } catch {
      navigate('/client/inbox');
    }
  };


  const renderStars = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    return (
      <div className="flex items-center space-x-0.5">
        {[...Array(5)].map((_, i) => (
          <Star
            key={i}
            className={`w-4 h-4 ${
              i < fullStars
                ? 'text-yellow-400 fill-yellow-400'
                : i === fullStars && hasHalfStar
                ? 'text-yellow-400 fill-yellow-400/50'
                : 'text-gray-300'
            }`}
          />
        ))}
        {rating > 0 && <span className="ml-1 text-sm font-semibold text-gray-700">{rating}</span>}
      </div>
    );
  };

  const renderCaregiverCard = (caregiver: TeamCaregiver) => (
    <div
      key={caregiver.id + caregiver.bookingId}
      className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow"
    >
      <div className="p-6">
        {/* Top Section: Photo and Basic Info */}
        <div className="flex items-start space-x-4">
          <div className="relative">
            <img
              src={
                caregiver.imageUrl ||
                `https://ui-avatars.com/api/?name=${encodeURIComponent(caregiver.name)}&background=random`
              }
              alt={caregiver.name}
              className="w-20 h-20 rounded-full object-cover border-4 border-white shadow-md"
            />
            {caregiver.isTopRated && (
              <div className="absolute -bottom-1 -right-1 bg-gradient-to-r from-yellow-400 to-accent-500 text-white text-xs font-bold px-2 py-0.5 rounded-full shadow-sm">
                Top rated
              </div>
            )}
          </div>

          <div className="flex-1">
            <h2 className="text-xl font-bold text-gray-900">{caregiver.name}</h2>
            <p className="text-sm text-gray-500 mb-2">Caregiver</p>
            {renderStars(caregiver.rating)}
            <CaregiverVerificationBadges
              verified={caregiver.verified}
              backgroundCheckStatus={caregiver.backgroundCheckStatus}
              className="mt-2"
            />
          </div>
        </div>

        {/* Stats Row */}
        <div className="flex items-center space-x-6 mt-5 pt-4 border-t border-gray-100">
          {caregiver.yearsExperience > 0 && (
            <div className="flex items-center space-x-2">
              <Calendar className="w-4 h-4 text-primary-600" />
              <span className="text-sm text-gray-600">
                <span className="font-semibold text-gray-900">{caregiver.yearsExperience}</span> yrs exp.
              </span>
            </div>
          )}
          {(caregiver.bookingRate || caregiver.hourlyRate) ? (
            <div className="flex items-center space-x-1">
              <span className="text-lg font-bold text-primary-600">
                ${caregiver.bookingRate ?? caregiver.hourlyRate}
              </span>
              <span className="text-sm text-gray-500">/hr</span>
            </div>
          ) : null}
        </div>

        {/* Schedule Days */}
        {caregiver.scheduleDays && caregiver.scheduleDays.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-4">
            {caregiver.scheduleDays.map(day => (
              <span
                key={day}
                className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700"
              >
                {day}
              </span>
            ))}
          </div>
        )}

        {/* Specialties */}
        {caregiver.specialties && caregiver.specialties.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {caregiver.specialties.slice(0, 3).map(specialty => (
              <span
                key={specialty}
                className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary-50 text-primary-700"
              >
                <Shield className="w-3 h-3 mr-1" />
                {specialty}
              </span>
            ))}
          </div>
        )}

        {/* Caring for */}
        {caregiver.careRecipients && caregiver.careRecipients.length > 0 && (
          <div className="flex items-center space-x-2 mt-4 text-sm text-gray-600">
            <Heart className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span>
              Caring for:{' '}
              <span className="font-medium text-gray-900">
                {caregiver.careRecipients
                  .map((r: any) => r.firstName || r.name || 'Recipient')
                  .join(', ')}
              </span>
            </span>
          </div>
        )}

        {/* Next Shift / In Progress / Today */}
        {caregiver.nextShift && caregiver.bookingStatus === 'accepted' && (
          caregiver.nextShift === 'In progress' ? (
            <div className="flex items-center space-x-2 mt-3 text-sm">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
              </span>
              <span className="font-semibold text-green-600">Shift in progress</span>
            </div>
          ) : caregiver.nextShift === 'Today' ? (
            <div className="flex items-center space-x-2 mt-3 text-sm text-gray-600">
              <Clock className="w-4 h-4 text-primary-500" />
              <span>Shift <span className="font-semibold text-primary-600">today</span></span>
            </div>
          ) : (
            <div className="flex items-center space-x-2 mt-3 text-sm text-gray-600">
              <Clock className="w-4 h-4 text-gray-400" />
              <span>Next shift: <span className="font-medium text-gray-900">{caregiver.nextShift}</span></span>
            </div>
          )
        )}

        {/* Past booking note */}
        {caregiver.bookingStatus === 'cancelled' && (
          <div className="mt-4 text-xs text-gray-400 italic">Booking ended</div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-2 mt-6">
          <Button
            onClick={() => handleMessage(caregiver.id, caregiver.name)}
            className="flex-1 bg-primary-600 hover:bg-primary-700 text-white"
          >
            <MessageSquare className="w-4 h-4 mr-2" />
            Message
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate(`/client/caregiver/${caregiver.id}`)}
            className="flex-1 border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            <User className="w-4 h-4 mr-2" />
            Profile
          </Button>
          {activeTab === 'past' && (
            <Button
              variant="outline"
              onClick={() => navigate(`/client/posts?rebook=${caregiver.id}`)}
              className="flex-1 border-primary-300 text-primary-700 hover:bg-primary-50"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Re-book
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ClientNavigation />
        <div className="flex items-center justify-center h-[calc(100vh-64px)]">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
        </div>
      </div>
    );
  }

  const baseList = activeTab === 'active' ? activeCaregivers : pastCaregivers;
  const displayedCaregivers = query.trim()
    ? baseList.filter(c => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    : baseList;

  return (
    <div className="min-h-screen bg-gray-50">
      <ClientNavigation />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-32">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">My Care Team</h1>
        </div>

        {/* Active / Past Tabs + Search */}
        <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="flex space-x-1 bg-gray-100 rounded-xl p-1 w-fit">
          {(['active', 'past'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'active' ? 'Active' : 'Past'}
              {tab === 'active' && activeCaregivers.length > 0 && (
                <span className="ml-2 bg-primary-100 text-primary-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                  {activeCaregivers.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 min-w-[200px] relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
          />
        </div>
        </div>

        {/* Caregiver Cards Grid */}
        {displayedCaregivers.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {displayedCaregivers.map(renderCaregiverCard)}
          </div>
        ) : (
          <div className="text-center py-16">
            <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Heart className="w-10 h-10 text-gray-400" />
            </div>
            {activeTab === 'active' ? (
              <>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">No active caregivers</h3>
                <p className="text-gray-600 mb-6">
                  Your care team will appear here once a caregiver accepts your booking.
                </p>
                <Button onClick={() => navigate('/client/dashboard')}>
                  Find a Caregiver
                </Button>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">No past caregivers</h3>
                <p className="text-gray-600">Past or ended bookings will appear here.</p>
              </>
            )}
          </div>
        )}



        {showIdentityGate && (
          <IdentityGateModal
            onClose={() => { setShowIdentityGate(false); }}
            onGetVerified={() => {
              setShowIdentityGate(false);
              navigate('/client/account');
              addToast('Complete identity verification in Account Settings', 'info');
            }}
          />
        )}
      </main>
    </div>
  );
};

export default MyCareTeam;
