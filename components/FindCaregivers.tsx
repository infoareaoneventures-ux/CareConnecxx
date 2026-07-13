import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Heart, MapPin, Star, CheckCircle, Sparkles, TrendingUp,
  MessageSquare, Shield, Search, SlidersHorizontal, X,
  ChevronDown, Briefcase,
  Pill, Car, Brain, Activity, Users, Video,
} from 'lucide-react';
import { auth, db } from '../lib/firebase';
import { hasValidTransportDocs } from '../utils/transportDocs';
import { isCaregiverBookable } from '../utils/caregiverEligibility';
import firebase from 'firebase/compat/app';
import { AIMatchScore } from '../services/aiMatchingService';
import { dbService } from '../services/api';
import { logMatchSignal } from '../services/matchFeedback';
import { ClientNavigation } from './client/ClientNavigation';
import { CreditCardBadge } from './shared/CreditCardBadge';
import { CaregiverVerificationBadges } from './shared/CaregiverVerificationBadges';
import { useAccessGates } from '../hooks/useAccessGates';
import { useCareConnex } from '../context/CareConnexContext';
import { ScheduleInterviewModal } from './ScheduleInterviewModal';
import ClientCaregiverProfile from './ClientCaregiverProfile';

interface Caregiver {
  id: string;
  firstName: string;
  lastName: string;
  hourlyRate: number;
  rating: number;
  reviewCount?: number;
  city: string;
  state?: string;
  zipCode?: string;
  street?: string;
  verified: boolean;
  backgroundCheckStatus?: 'none' | 'pending' | 'clear' | 'flagged' | 'consider';
  distance: number;
  lat?: number;
  lng?: number;
  photoURL?: string;
  hasReliableTransportation: boolean;
  skills?: string[];
  certifications?: string[];
  languages?: string[];
  experience?: number;
  bio?: string;
  lastActive?: string;
  repeatFamilies?: number;
  availability?: string[];
  serviceRadius?: number;
}

type SortOption = 'rating' | 'price-low' | 'price-high';

const SENIOR_SPECIALTIES = [
  { key: 'Mobility Assistance', icon: Activity },
  { key: 'Dementia / Memory Care', icon: Brain },
  { key: 'Medication Reminders', icon: Pill },
  { key: 'Personal Care', icon: Users },
  { key: 'Companionship', icon: Heart },
  { key: 'Transportation', icon: Car },
  { key: 'Meal Preparation', icon: Users },
  { key: 'Light Housekeeping', icon: Users },
];

const LANGUAGES = ['English', 'Spanish', 'Mandarin', 'Tagalog', 'Vietnamese', 'Korean', 'Russian', 'Arabic'];
const EXPERIENCE_TIERS = [
  { key: 0, label: 'Any experience' },
  { key: 1, label: '1+ years' },
  { key: 3, label: '3+ years' },
  { key: 5, label: '5+ years' },
  { key: 10, label: '10+ years' },
];


function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatLastActive(iso?: string): string {
  if (!iso) return 'active recently';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins < 2 ? 'just now' : `${mins} min ago`}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `active ${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `active ${days} day${days !== 1 ? 's' : ''} ago`;
  return 'active over a week ago';
}

export default function FindCaregivers() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [caregivers, setCaregivers] = useState<(Caregiver & { matchScore?: AIMatchScore })[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [clientIntakeData, setClientIntakeData] = useState<any>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('rating');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(searchParams.get('tab') === 'favorites');
  const { gate, Modals: GateModals } = useAccessGates();
  const { blockedIds } = useCareConnex();
  const [viewingCaregiver, setViewingCaregiver] = useState<(Caregiver & { matchScore?: AIMatchScore }) | null>(null);
  const [interviewCaregiver, setInterviewCaregiver] = useState<(Caregiver & { matchScore?: AIMatchScore }) | null>(null);
  const [clientOpenPosts, setClientOpenPosts] = useState<{ id: string; title: string }[]>([]);
  const [bookedCaregiverIds, setBookedCaregiverIds] = useState<Set<string>>(new Set());
  const [requestedCaregiverIds, setRequestedCaregiverIds] = useState<Set<string>>(new Set());

  // Client care locations — all lat/lngs from job_posts, job_postings, carePlans, users
  const [clientLocations, setClientLocations] = useState<{ lat: number; lng: number }[]>([]);

  // Filters
  const [nameQuery, setNameQuery] = useState('');
  const [maxRate, setMaxRate] = useState(75);
  const [maxDistance, setMaxDistance] = useState(25);
  const [minRating, setMinRating] = useState(0);
  const [minExperience, setMinExperience] = useState(0);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [transportationOnly, setTransportationOnly] = useState(false);
  const [selectedSpecialties, setSelectedSpecialties] = useState<Set<string>>(new Set());
  const [selectedLanguages, setSelectedLanguages] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadClientDataAndCaregivers();
  }, []);


  const loadClientDataAndCaregivers = async () => {
    try {
      if (!auth || !db) return;
      const fdb = db;
      const user = auth.currentUser;
      if (!user) {
        navigate('/login');
        return;
      }

      const intakeDoc = await fdb.collection('clientIntakes').doc(user.uid).get();
      let intakeData = null;
      if (intakeDoc.exists) {
        intakeData = intakeDoc.data();
        setClientIntakeData(intakeData);
      }

      // Load accepted booking caregiver IDs — fire and forget
      fdb.collection('booking_requests')
        .where('clientId', '==', user.uid)
        .where('status', '==', 'accepted')
        .get()
        .then(snap => {
          const ids = new Set<string>(snap.docs.map(d => d.data().caregiverId).filter(Boolean));
          setBookedCaregiverIds(ids);
        })
        .catch(() => {});

      // Load caregivers with active (non-terminal) interview requests
      fdb.collection('video_interviews')
        .where('clientId', '==', user.uid)
        .get()
        .then(snap => {
          const activeStatuses = new Set(['requested', 'pending', 'scheduled']);
          const ids = new Set<string>(
            snap.docs
              .filter(d => activeStatuses.has(d.data().status))
              .map(d => d.data().caregiverId)
              .filter(Boolean)
          );
          setRequestedCaregiverIds(ids);
        })
        .catch(() => {});

      // ── Collect all client care location lat/lngs in parallel ──
      const [postsSnap, jpDoc, cpDoc] = await Promise.all([
        fdb.collection('job_posts').where('clientId', '==', user.uid).where('status', '==', 'open').get(),
        fdb.collection('job_postings').doc(user.uid).get(),
        fdb.collection('carePlans').doc(user.uid).get(),
      ]);

      // Populate clientOpenPosts from the same query
      const openPosts = postsSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      setClientOpenPosts(openPosts.map((p: any) => ({ id: p.id, title: p.title, startDate: p.startDate || p.date })));

      const seen = new Set<string>();
      const locs: { lat: number; lng: number }[] = [];
      const addLoc = (lat: any, lng: any) => {
        if (lat == null || lng == null) return;
        const key = `${lat},${lng}`;
        if (!seen.has(key)) { seen.add(key); locs.push({ lat: Number(lat), lng: Number(lng) }); }
      };

      // 1. Open job posts
      openPosts.forEach((p: any) => addLoc(p.lat, p.lng));

      // 2. Wizard / onboarding job_postings
      if (jpDoc.exists) { const d = jpDoc.data() as any; addLoc(d.lat, d.lng); }

      // 3. Care plan location pool (geocoded when saved)
      if (cpDoc.exists) {
        const d = cpDoc.data() as any;
        (d.locationPool || []).forEach((loc: any) => addLoc(loc.lat, loc.lng));
      }

      // 4. Fallback — signup address on users/{uid}
      if (locs.length === 0) {
        const userDoc = await fdb.collection('users').doc(user.uid).get();
        if (userDoc.exists) { const d = userDoc.data() as any; addLoc(d.latitude, d.longitude); }
      }

      setClientLocations(locs);

      await fetchCaregivers(intakeData, locs);
      await fetchFavorites();
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCaregivers = async (intakeData: any, clientLocs: { lat: number; lng: number }[]) => {
    try {
      if (!auth || !db) return;
      const fdb = db;
      const user = auth.currentUser;
      const precomputedData = user ? await dbService.getClientMatches(user.uid) : null;
      const precomputedMatches = precomputedData?.topMatches || [];
      const matchMap = new Map(precomputedMatches.map((m) => [m.caregiverId, m]));

      // Discover caregivers from the `caregivers` collection ONLY. The old
      // parallel `users` query (role==caregiver) is gone: it exposed the whole
      // user directory to any authed client (firestore.rules users list was
      // open), and it was redundant — visibility is gated on approvedIds
      // (below), which is derived solely from `caregivers`, and every
      // profile_complete caregiver's caregivers doc carries name+geo (verified
      // against prod 2026-07-11: 0 caregivers relied on the users doc).
      const caregiversSnap = await fdb.collection('publicCaregiverProfiles')
        .where('onboardingStatus', '==', 'profile_complete').limit(100).get().catch(() => null);

      // Build set of visible caregiver IDs — bookability contract: onboardingStatus 'profile_complete'
      // (the query above) AND verificationStatus 'approved' (post-filter; the where() is pre-filtering only)
      const approvedIds = new Set<string>(
        caregiversSnap?.docs.filter(d => isCaregiverBookable(d.data() as any)).map(d => d.id) ?? []
      );

      const seen = new Set<string>();
      const caregiverList: Caregiver[] = [];

      const pushDoc = (doc: firebase.firestore.DocumentSnapshot) => {
        if (seen.has(doc.id)) return;
        // Only show caregivers that have completed their profile wizard (onboardingStatus: profile_complete)
        if (!approvedIds.has(doc.id)) return;
        const data = doc.data() || {};
        const firstName = data.firstName || data.name?.split(' ')[0] || '';
        const lastName = data.lastName || data.name?.split(' ').slice(1).join(' ') || '';
        if (!firstName && !lastName && !data.name) return;
        seen.add(doc.id);
        const cgLat: number | undefined = data.lat ?? data.latitude ?? data.location?.lat ?? data._geoloc?.lat;
        const cgLng: number | undefined = data.lng ?? data.longitude ?? data.location?.lng ?? data._geoloc?.lng;
        // Minimum distance from any client care location to this caregiver's home
        let minDist = 0;
        if (cgLat != null && cgLng != null && clientLocs.length > 0) {
          minDist = Math.min(...clientLocs.map(loc => haversineDistance(loc.lat, loc.lng, cgLat, cgLng)));
          minDist = Math.round(minDist * 10) / 10;
        }
        caregiverList.push({
          id: doc.id,
          firstName,
          lastName,
          hourlyRate: data.hourlyRate || 25,
          rating: data.rating || 5.0,
          reviewCount: data.reviewCount ?? 0,
          city: data.city || data.location?.city || 'Nearby',
          state: data.state || data.location?.state,
          zipCode: data.zipCode || data.zip,
          street: data.street || data.streetAddress,
          verified: data.backgroundCheckComplete || data.verified || false,
          backgroundCheckStatus: data.backgroundCheckStatus || data.backgroundCheckData?.status || (data.backgroundCheckComplete || data.verified ? 'clear' : 'none'),
          distance: minDist,
          lat: cgLat,
          lng: cgLng,
          photoURL: data.photoURL || data.photo || data.imageUrl || data.profilePhoto,
          hasReliableTransportation: hasValidTransportDocs(data),
          skills: data.skills || data.specializations || data.specialties || [],
          certifications: data.certifications || [],
          languages: data.languages || ['English'],
          experience: data.experience || data.yearsExperience || 0,
          bio: data.bio || data.about || '',
          lastActive: data.lastActive || new Date().toISOString(),
          repeatFamilies: data.repeatFamilies ?? 0,
          availability: Array.isArray(data.availability) ? data.availability : [],
          serviceRadius: data.serviceRadius ?? data.travelRadius,
        });
      };

      caregiversSnap?.forEach(pushDoc);

      let caregiversWithScores: (Caregiver & { matchScore?: AIMatchScore })[] = caregiverList;

      if (matchMap.size > 0) {
        caregiversWithScores = caregiverList.map((cg) => {
          const pre = matchMap.get(cg.id);
          if (!pre) return cg;
          const matchScore: AIMatchScore = {
            caregiverId: cg.id,
            caregiverName: `${cg.firstName} ${cg.lastName}`.trim(),
            overallScore: pre.score,
            reasoning: pre.reasons,
            redFlags: pre.redFlags || [],
            confidence: pre.confidence,
            breakdown: { ruleBasedScore: pre.score, predictiveScore: pre.score },
            factors: { distance: cg.distance, skillsMatch: pre.score, availability: 1, experience: cg.experience || 0, rating: cg.rating, retention: 0 },
          } as AIMatchScore;
          return { ...cg, matchScore };
        });
      }

      setCaregivers(caregiversWithScores);
    } catch (error) {
      console.error('Error fetching caregivers:', error);
    }
  };

  const fetchFavorites = async () => {
    try {
      if (!auth || !db) return;
      const fdb = db;
      const user = auth.currentUser;
      if (!user) return;
      const userDoc = await fdb.collection('users').doc(user.uid).get();
      setFavorites((userDoc.data() as any)?.savedCaregiverIds || []);
    } catch {
      // non-critical
    }
  };

  const toggleFavorite = async (caregiverId: string) => {
    try {
      if (!auth || !db) return;
      const user = auth.currentUser;
      if (!user) { navigate('/login'); return; }
      const userRef = db.collection('users').doc(user.uid);
      const isFav = favorites.includes(caregiverId);
      if (isFav) {
        await userRef.update({ savedCaregiverIds: firebase.firestore.FieldValue.arrayRemove(caregiverId) });
        setFavorites(prev => prev.filter(id => id !== caregiverId));
      } else {
        await userRef.update({ savedCaregiverIds: firebase.firestore.FieldValue.arrayUnion(caregiverId) });
        setFavorites(prev => [...prev, caregiverId]);
        logMatchSignal(caregiverId, 'favorited');
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
    }
  };

  const openChat = (caregiverId: string, caregiverName: string) => {
    const currentUid = auth?.currentUser?.uid;
    if (!currentUid) { navigate('/client/inbox'); return; }
    const currentName = auth?.currentUser?.displayName || auth?.currentUser?.email?.split('@')[0] || 'Client';
    const sorted = [currentUid, caregiverId].sort();
    const roomId = sorted.join('_');
    const names = sorted.map(id => id === currentUid ? currentName : caregiverName);
    navigate(`/client/inbox?room=${roomId}`, {
      state: {
        pendingRoom: {
          id: roomId, participants: sorted, participantNames: names, participantAvatars: ['', ''],
          unreadCount: { [currentUid]: 0, [caregiverId]: 0 },
          lastMessage: '', lastMessageTime: '', lastMessageTimestamp: null, createdAt: null,
        }
      }
    });
  };

  const handleMessage = (caregiverId: string, caregiverName: string) => {
    gate('message', caregiverName, () => openChat(caregiverId, caregiverName));
  };

  const handleRequestInterview = (cg: Caregiver & { matchScore?: AIMatchScore }) => {
    const name = `${cg.firstName} ${cg.lastName}`.trim();
    gate('interview', name, () => setInterviewCaregiver(cg));
  };

  const toggleSetItem = (set: Set<string>, item: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(item)) next.delete(item); else next.add(item);
    setter(next);
  };

  const clearAllFilters = () => {
    setNameQuery('');
    setMaxRate(75);
    setMaxDistance(25);
    setMinRating(0);
    setMinExperience(0);
    setVerifiedOnly(false);
    setTransportationOnly(false);
    setSelectedSpecialties(new Set());
    setSelectedLanguages(new Set());
    setShowFavoritesOnly(false);
  };

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (nameQuery) n++;
    if (maxRate < 75 || maxRate >= 100) n++;
    if (maxDistance !== 25) n++;
    if (minRating > 0) n++;
    if (minExperience > 0) n++;
    if (verifiedOnly) n++;
    if (transportationOnly) n++;
    n += selectedSpecialties.size;
    n += selectedLanguages.size;
    return n;
  }, [nameQuery, maxRate, maxDistance, minRating, minExperience, verifiedOnly, transportationOnly, selectedSpecialties, selectedLanguages]);

  const filteredCaregivers = useMemo(() => {
    let list = caregivers.filter(cg => {
      if (blockedIds.has(cg.id)) return false;
      if (showFavoritesOnly && !favorites.includes(cg.id)) return false;
      // Distance filter — only applied when client has locations AND caregiver has coords
      if (clientLocations.length > 0 && cg.lat != null && cg.lng != null) {
        if (cg.distance > maxDistance) return false;
      }
      if (nameQuery) {
        const q = nameQuery.toLowerCase();
        const name = `${cg.firstName} ${cg.lastName}`.toLowerCase();
        const city = (cg.city || '').toLowerCase();
        const state = (cg.state || '').toLowerCase();
        const zip = (cg.zipCode || '').toLowerCase();
        if (!name.includes(q) && !city.includes(q) && !state.includes(q) && !zip.includes(q)) return false;
      }
      if (maxRate < 100 && cg.hourlyRate > maxRate) return false;
      if (cg.rating < minRating) return false;
      if ((cg.experience || 0) < minExperience) return false;
      if (verifiedOnly && !cg.verified) return false;
      if (transportationOnly && !cg.hasReliableTransportation) return false;
      if (selectedSpecialties.size > 0) {
        const skillSet = new Set((cg.skills || []).map(s => s.toLowerCase()));
        let hasAny = false;
        selectedSpecialties.forEach(s => {
          if (skillSet.has(s.toLowerCase())) hasAny = true;
        });
        if (!hasAny) return false;
      }
      if (selectedLanguages.size > 0) {
        const langSet = new Set((cg.languages || []).map(l => l.toLowerCase()));
        let hasAny = false;
        selectedLanguages.forEach(l => { if (langSet.has(l.toLowerCase())) hasAny = true; });
        if (!hasAny) return false;
      }
      return true;
    });

    const sorted = [...list];
    switch (sortBy) {
      case 'rating':
        sorted.sort((a, b) => b.rating - a.rating);
        break;
      case 'price-low':
        sorted.sort((a, b) => a.hourlyRate - b.hourlyRate);
        break;
      case 'price-high':
        sorted.sort((a, b) => b.hourlyRate - a.hourlyRate);
        break;
      default:
        sorted.sort((a, b) => b.rating - a.rating);
        break;
    }
    return sorted;
  }, [caregivers, blockedIds, favorites, showFavoritesOnly, clientLocations, maxDistance, nameQuery, maxRate, minRating, minExperience, verifiedOnly, transportationOnly, selectedSpecialties, selectedLanguages, sortBy]);

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

  const FilterPanel = (
    <div className="space-y-5">
      {/* Name / Location search */}
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Search</label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Name, city, or zip code"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Distance — only shown when client has geocoded care locations */}
      {clientLocations.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Distance</label>
            <span className="text-xs text-slate-600 font-medium">within {maxDistance} mi</span>
          </div>
          <input
            type="range" min={5} max={50} step={5}
            value={maxDistance}
            onChange={(e) => setMaxDistance(Number(e.target.value))}
            className="w-full accent-teal-600"
          />
        </div>
      )}

      {/* Rate per hour */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Max Rate</label>
          <span className="text-xs text-slate-600 font-medium">
            {maxRate >= 100 ? '$100+/hr' : `up to $${maxRate}/hr`}
          </span>
        </div>
        <input
          type="range" min={15} max={100} step={5}
          value={maxRate}
          onChange={(e) => setMaxRate(Number(e.target.value))}
          className="w-full accent-teal-600"
        />
      </div>

      {/* Rating */}
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Rating</label>
        <div className="flex gap-1.5">
          {[0, 3, 4, 4.5].map(r => (
            <button
              key={r}
              onClick={() => setMinRating(r)}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                minRating === r ? 'bg-primary-600 border-primary-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {r === 0 ? 'Any' : `${r}+★`}
            </button>
          ))}
        </div>
      </div>

      {/* Experience */}
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Experience</label>
        <div className="space-y-1.5">
          {EXPERIENCE_TIERS.map(tier => (
            <label key={tier.key} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
              <input
                type="radio"
                name="experience"
                checked={minExperience === tier.key}
                onChange={() => setMinExperience(tier.key)}
                className="accent-teal-600"
              />
              {tier.label}
            </label>
          ))}
        </div>
      </div>

      {/* Trust & Safety */}
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Trust & Safety</label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
              className="accent-teal-600 rounded"
            />
            <Shield className="w-4 h-4 text-primary-600" />
            Background checked only
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
            <input
              type="checkbox"
              checked={transportationOnly}
              onChange={(e) => setTransportationOnly(e.target.checked)}
              className="accent-teal-600 rounded"
            />
            <Car className="w-4 h-4 text-primary-600" />
            Reliable transportation
          </label>
        </div>
      </div>

      {/* Specialties */}
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Senior Care Specialties</label>
        <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
          {SENIOR_SPECIALTIES.map(({ key }) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
              <input
                type="checkbox"
                checked={selectedSpecialties.has(key)}
                onChange={() => toggleSetItem(selectedSpecialties, key, setSelectedSpecialties)}
                className="accent-teal-600 rounded"
              />
              {key}
            </label>
          ))}
        </div>
      </div>

      {/* Languages */}
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Languages</label>
        <div className="flex flex-wrap gap-1.5">
          {LANGUAGES.map(lang => (
            <button
              key={lang}
              onClick={() => toggleSetItem(selectedLanguages, lang, setSelectedLanguages)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                selectedLanguages.has(lang)
                  ? 'bg-primary-600 border-primary-600 text-white'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {lang}
            </button>
          ))}
        </div>
      </div>

      {activeFilterCount > 0 && (
        <button
          onClick={clearAllFilters}
          className="w-full text-sm text-primary-600 font-medium hover:text-primary-700 py-2 border border-primary-100 rounded-lg hover:bg-primary-50 transition-colors"
        >
          Clear all filters ({activeFilterCount})
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-primary-600" />
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">Find Senior Caregivers</h1>
            </div>
          </div>
        </div>

        {/* Top bar: tabs + sort */}
        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <button
            onClick={() => setShowFavoritesOnly(false)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              !showFavoritesOnly
                ? 'bg-primary-600 border-primary-600 text-white'
                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
            }`}
          >
            All ({caregivers.length})
          </button>
          <button
            onClick={() => setShowFavoritesOnly(true)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors inline-flex items-center gap-1.5 ${
              showFavoritesOnly
                ? 'bg-primary-600 border-primary-600 text-white'
                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
            }`}
          >
            <Heart className={`w-3.5 h-3.5 ${showFavoritesOnly ? 'fill-current' : ''}`} />
            Favorites ({favorites.length})
          </button>

          <button
            onClick={() => setMobileFiltersOpen(true)}
            className="lg:hidden ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-full text-sm font-medium text-slate-700"
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters{activeFilterCount > 0 && ` (${activeFilterCount})`}
          </button>

          <div className="ml-auto hidden lg:flex items-center gap-2 text-sm text-slate-600">
            <span>Sort by:</span>
            <div className="relative">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="appearance-none bg-white border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 cursor-pointer hover:border-slate-300 focus:ring-2 focus:ring-primary-500 focus:outline-none"
              >
                <option value="rating">Highest rated</option>
                <option value="price-low">Price: Low to High</option>
                <option value="price-high">Price: High to Low</option>
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
          </div>
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
          {/* Filter sidebar (desktop) */}
          <aside className="hidden lg:block">
            <div className="bg-white rounded-xl border border-slate-200 p-5 sticky top-20">
              <h2 className="font-semibold text-slate-900 mb-4 flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4" />
                Filters
              </h2>
              {FilterPanel}
            </div>
          </aside>

          {/* Results */}
          <section>
            {/* Mobile sort */}
            <div className="lg:hidden mb-3 flex items-center gap-2 text-sm text-slate-600">
              <span>Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700"
              >
                <option value="rating">Highest rated</option>
                <option value="price-low">Price: Low to High</option>
                <option value="price-high">Price: High to Low</option>
              </select>
            </div>

            <p className="text-sm text-slate-500 mb-3">
              {filteredCaregivers.length} caregiver{filteredCaregivers.length !== 1 ? 's' : ''} found
            </p>

            {filteredCaregivers.length === 0 ? (
              <EmptyState
                hasFilters={activeFilterCount > 0 || showFavoritesOnly}
                onClear={clearAllFilters}
                onPostJob={() => navigate('/client/posts')}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredCaregivers.map((cg, index) => (
                  <CaregiverCard
                    key={cg.id}
                    caregiver={cg}
                    isFavorite={favorites.includes(cg.id)}
                    isBooked={bookedCaregiverIds.has(cg.id)}
                    isRequested={requestedCaregiverIds.has(cg.id)}
                    onToggleFavorite={() => toggleFavorite(cg.id)}
                    onViewProfile={() => setViewingCaregiver(cg)}
                    onMessage={() => handleMessage(cg.id, `${cg.firstName} ${cg.lastName}`.trim())}
                    onRequestInterview={() => handleRequestInterview(cg)}
                    isBestMatch={false}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Full caregiver profile modal */}
      {viewingCaregiver && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm overflow-y-auto"
          onClick={() => setViewingCaregiver(null)}
        >
          <div
            className="min-h-full flex items-start justify-center py-6 px-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="bg-slate-50 rounded-2xl w-full max-w-5xl shadow-2xl relative overflow-hidden">
              {/* Close button */}
              <button
                onClick={() => setViewingCaregiver(null)}
                className="absolute top-4 right-4 z-50 p-2 bg-white/80 hover:bg-white rounded-full shadow-md transition-colors"
              >
                <X className="w-5 h-5 text-slate-600" />
              </button>
              <ClientCaregiverProfile
                modalMode
                overrideId={viewingCaregiver.id}
                overrideData={viewingCaregiver}
                onClose={() => setViewingCaregiver(null)}
              />
            </div>
          </div>
        </div>
      )}

      {interviewCaregiver && (
        <ScheduleInterviewModal
          caregiver={{
            id: interviewCaregiver.id,
            name: `${interviewCaregiver.firstName} ${interviewCaregiver.lastName}`.trim(),
            imageUrl: interviewCaregiver.photoURL,
            hourlyRate: interviewCaregiver.hourlyRate,
            rating: interviewCaregiver.rating,
            distance: interviewCaregiver.distance,
            skills: interviewCaregiver.skills || [],
            availability: interviewCaregiver.availability || [],
            experience: typeof interviewCaregiver.experience === 'number' ? interviewCaregiver.experience : 0,
          } as any}
          jobPosts={clientOpenPosts}
          onClose={() => setInterviewCaregiver(null)}
          onSuccess={() => {
            if (interviewCaregiver) {
              setRequestedCaregiverIds(prev => new Set([...prev, interviewCaregiver.id]));
            }
            setInterviewCaregiver(null);
          }}
          onShowToast={() => {}}
        />
      )}

      {/* Identity + membership gates (shown conditionally based on user state) */}
      <GateModals />

      {/* Mobile filter drawer */}
      {mobileFiltersOpen && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileFiltersOpen(false)} />
          <div className="absolute right-0 top-0 bottom-0 w-[85%] max-w-sm bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <h2 className="font-semibold text-slate-900 flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4" />
                Filters
              </h2>
              <button onClick={() => setMobileFiltersOpen(false)} className="p-1.5 hover:bg-slate-100 rounded-full">
                <X className="w-5 h-5 text-slate-600" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">{FilterPanel}</div>
            <div className="p-4 border-t border-slate-200">
              <button
                onClick={() => setMobileFiltersOpen(false)}
                className="w-full py-2.5 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700"
              >
                Show {filteredCaregivers.length} caregivers
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Caregiver Card ───────────────────────────────────────────
interface CaregiverCardProps {
  caregiver: Caregiver & { matchScore?: AIMatchScore };
  isFavorite: boolean;
  isBestMatch?: boolean;
  isBooked?: boolean;
  isRequested?: boolean;
  onToggleFavorite: () => void;
  onViewProfile: () => void;
  onMessage: () => void;
  onRequestInterview: () => void;
}

const CaregiverCard: React.FC<CaregiverCardProps> = ({
  caregiver, isFavorite, isBestMatch, isBooked, isRequested, onToggleFavorite, onViewProfile, onMessage, onRequestInterview,
}) => {
  const fullName = `${caregiver.firstName} ${caregiver.lastName}`.trim() || 'Caregiver';

  return (
    <div className="bg-white rounded-[1.5rem] border border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col relative">
      {/* Absolute Favorite Button */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
        className="absolute top-4 right-4 p-2 bg-white/80 hover:bg-slate-50 backdrop-blur-sm rounded-full shadow-sm z-10 transition-colors"
        aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Heart className={`w-5 h-5 transition-colors ${isFavorite ? 'text-red-500 fill-current' : 'text-slate-400 hover:text-red-400'}`} />
      </button>

      {isBestMatch && (
        <div className="bg-gradient-to-r from-primary-500 to-blue-500 text-white text-[11px] font-bold px-4 py-1.5 flex items-center gap-1.5 uppercase tracking-wide">
          <TrendingUp className="w-3.5 h-3.5" />
          Best match
        </div>
      )}

      {/* Main Profile Area (Clickable to view full profile) */}
      <div 
        className="p-5 flex-1 flex flex-col cursor-pointer group"
        onClick={onViewProfile}
      >
        {/* Top row: photo + name + badges */}
        <div className="flex items-start gap-4 mb-5">
          <div className="w-20 h-20 rounded-full bg-slate-200 overflow-hidden flex items-center justify-center flex-shrink-0 shadow-inner group-hover:ring-4 ring-primary-50 transition-all">
            {caregiver.photoURL ? (
              <img src={caregiver.photoURL} alt={fullName} className="w-full h-full object-cover" />
            ) : (
              <span className="text-2xl font-bold text-slate-400">
                {caregiver.firstName.charAt(0)}{caregiver.lastName.charAt(0)}
              </span>
            )}
          </div>
          
          <div className="flex-1 min-w-0 pt-1 pr-10">
            <h3 className="text-[22px] font-bold text-slate-900 group-hover:text-primary-600 transition-colors truncate mb-1 leading-tight">{fullName}</h3>
            
            <div className="flex items-center gap-0.5 mb-2.5">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className={`w-[18px] h-[18px] ${i < Math.floor(caregiver.rating) ? 'text-teal-500 fill-current' : 'text-slate-200'}`} />
              ))}
              <span className="text-sm font-medium text-slate-500 ml-1.5">({caregiver.reviewCount || 0})</span>
            </div>

            <CreditCardBadge show={!!(caregiver as any).acceptsCreditCards} />
            
            <CaregiverVerificationBadges verified={caregiver.verified} backgroundCheckStatus={caregiver.backgroundCheckStatus} />
          </div>
        </div>

        {/* Details section */}
        <div className="space-y-3.5 mb-5 mt-1">
          <div className="flex items-center gap-3.5 text-slate-700">
            <Briefcase className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
            <span className="text-[17px]">{caregiver.experience || 0} experience</span>
          </div>
          <div className="flex items-center gap-3.5 text-slate-700">
            <MapPin className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
            <span className="text-[17px]">
              {[caregiver.city, caregiver.state].filter(Boolean).join(', ')}
              {caregiver.zipCode ? ` ${caregiver.zipCode}` : ''}
              {!caregiver.city && !caregiver.zipCode && 'Nearby'}
            </span>
            {caregiver.hourlyRate > 0 && (
              <>
                <span className="text-slate-300">·</span>
                <span className="text-[17px] font-semibold text-slate-800">${caregiver.hourlyRate}/hr</span>
              </>
            )}
          </div>
        </div>

        {/* Skills pill tags */}
        {(caregiver.skills && caregiver.skills.length > 0) ? (
          <div className="flex gap-2 mb-6 mt-1">
            {caregiver.skills.slice(0, 2).map(skill => (
              <span key={skill} className="shrink-0 px-3.5 py-1.5 bg-slate-100 border border-slate-200 text-slate-800 text-[13px] font-medium rounded-[1rem]">
                {skill}
              </span>
            ))}
            {caregiver.skills.length > 2 && (
              <span className="shrink-0 px-3.5 py-1.5 bg-white border border-slate-200 text-slate-500 text-[13px] font-medium rounded-[1rem]">
                +{caregiver.skills.length - 2}
              </span>
            )}
          </div>
        ) : (
          <div className="mb-6 mt-1"></div>
        )}


      </div>

      {/* Embedded Actions row appended to bottom edge natively so user can directly click primary actions */}
      <div className="bg-slate-50 border-t border-slate-100 p-3 grid grid-cols-2 gap-2">
         <button
            onClick={(e) => { e.stopPropagation(); onMessage(); }}
            className="flex-1 py-2 text-sm font-bold bg-white border-2 border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 hover:border-slate-300 transition-colors inline-flex items-center justify-center gap-1.5"
         >
            <MessageSquare className="w-4 h-4" /> Message
         </button>
         {isBooked ? (
            <div className="w-full py-2 text-sm font-bold bg-green-50 border-2 border-green-200 text-green-700 rounded-xl inline-flex items-center justify-center gap-1.5">
              <CheckCircle className="w-4 h-4" /> Active Booking
            </div>
         ) : isRequested ? (
            <div className="w-full py-2 text-sm font-bold bg-slate-100 border-2 border-slate-200 text-slate-500 rounded-xl inline-flex items-center justify-center gap-1.5">
              <CheckCircle className="w-4 h-4" /> Interview Requested
            </div>
         ) : (
            <button
               onClick={(e) => { e.stopPropagation(); onRequestInterview(); }}
               className="w-full py-2 text-sm font-bold bg-primary-600 border-2 border-primary-600 text-white rounded-xl hover:bg-primary-700 hover:border-primary-700 transition-colors inline-flex items-center justify-center gap-1.5"
            >
               <Video className="w-4 h-4" /> Request Interview
            </button>
         )}
      </div>

    </div>
  );
};

// ─── Empty State ──────────────────────────────────────────────
const EmptyState: React.FC<{ hasFilters: boolean; onClear: () => void; onPostJob: () => void }> = ({
  hasFilters, onClear, onPostJob,
}) => (
  <div className="bg-white rounded-xl border border-dashed border-slate-300 p-10 text-center">
    <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
      <Search className="w-7 h-7 text-slate-400" />
    </div>
    <h3 className="text-lg font-semibold text-slate-900 mb-1">
      {hasFilters ? 'No caregivers match your filters' : 'No caregivers available yet'}
    </h3>
    <p className="text-sm text-slate-500 mb-5 max-w-md mx-auto">
      {hasFilters
        ? 'Try widening your distance, raising your rate, or removing some specialties.'
        : "We're growing our caregiver network in your area. Post a job to invite matching caregivers to apply directly."}
    </p>
    <div className="flex gap-2 justify-center">
      {hasFilters && (
        <button onClick={onClear} className="px-4 py-2 text-sm font-semibold border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50">
          Clear filters
        </button>
      )}
      <button onClick={onPostJob} className="px-4 py-2 text-sm font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700">
        Post a Care Request
      </button>
    </div>
  </div>
);
