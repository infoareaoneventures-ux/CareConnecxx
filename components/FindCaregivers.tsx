import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Heart, MapPin, Star, CheckCircle, Sparkles, TrendingUp,
  MessageSquare, Shield, Search, SlidersHorizontal, X,
  ChevronDown, BookmarkPlus, Languages, Award,
  Pill, Car, Brain, Activity, Users, Video, Zap,
} from 'lucide-react';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { getAIMatches, AIMatchScore } from '../services/aiMatchingService';
import { dbService } from '../services/api';
import { logMatchSignal } from '../services/matchFeedback';
import { ClientNavigation } from './client/ClientNavigation';
import { CreditCardBadge } from './shared/CreditCardBadge';
import { CaregiverVerificationBadges } from './shared/CaregiverVerificationBadges';
import { chatService } from '../services/chatService';
import { useAccessGates } from '../hooks/useAccessGates';
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
}

type SortOption = 'best-match' | 'rating' | 'price-low' | 'price-high' | 'distance' | 'experience';

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
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const GEOCODE_CACHE_KEY = 'careconnex_geocode_v1';

function getGeocodeCache(): Record<string, { lat: number; lng: number }> {
  try { return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || '{}'); } catch { return {}; }
}

function setGeocodeCache(cache: Record<string, { lat: number; lng: number }>) {
  try { localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache)); } catch { /* storage full */ }
}

// Returns coords + whether they came from cache (cached = no rate-limit delay needed)
async function geocodeAddress(id: string, street?: string, city?: string, state?: string, zipCode?: string): Promise<{ lat: number; lng: number; cached: boolean } | null> {
  const cache = getGeocodeCache();
  if (cache[id]) return { ...cache[id], cached: true };
  const query = [street, city, state, zipCode].filter(Boolean).join(', ');
  if (!query) return null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'CareConnex/1.0' } }
    );
    const data = await res.json();
    if (!data?.length) return null;
    const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    setGeocodeCache({ ...getGeocodeCache(), [id]: result });
    return { ...result, cached: false };
  } catch {
    return null;
  }
}

function formatLastActive(iso?: string): string {
  if (!iso) return 'active recently';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `active ${mins < 2 ? 'just now' : `${mins} min ago`}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `active ${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `active ${days} day${days !== 1 ? 's' : ''} ago`;
  return 'active over a week ago';
}

export default function FindCaregivers() {
  const navigate = useNavigate();
  const [caregivers, setCaregivers] = useState<(Caregiver & { matchScore?: AIMatchScore })[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [clientIntakeData, setClientIntakeData] = useState<any>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('best-match');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const { gate, Modals: GateModals } = useAccessGates();
  const [viewingCaregiver, setViewingCaregiver] = useState<(Caregiver & { matchScore?: AIMatchScore }) | null>(null);
  const [interviewCaregiver, setInterviewCaregiver] = useState<(Caregiver & { matchScore?: AIMatchScore }) | null>(null);
  const [clientLat, setClientLat] = useState<number | null>(null);
  const [clientLng, setClientLng] = useState<number | null>(null);
  const [clientOpenPosts, setClientOpenPosts] = useState<{ id: string; title: string }[]>([]);

  // Filters
  const [nameQuery, setNameQuery] = useState('');
  const [maxDistance, setMaxDistance] = useState(25);
  const [maxRate, setMaxRate] = useState(75);
  const [minRating, setMinRating] = useState(0);
  const [minExperience, setMinExperience] = useState(0);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [transportationOnly, setTransportationOnly] = useState(false);
  const [selectedSpecialties, setSelectedSpecialties] = useState<Set<string>>(new Set());
  const [selectedLanguages, setSelectedLanguages] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadClientDataAndCaregivers();
  }, []);

  // Ref so caregiver geocoding closures always see the latest client coords
  const clientLatRef = useRef<number | null>(null);
  const clientLngRef = useRef<number | null>(null);

  // Resolve client's care location coordinates — reads from job_postings first (geocoded at post time),
  // falls back to geocoding their profile address if not yet stored.
  const resolveClientLocation = async (uid: string) => {
    try {
      const jpSnap = await db.collection('job_postings').doc(uid).get();
      const jp = jpSnap.data() as any;
      if (jp?.lat && jp?.lng) {
        clientLatRef.current = jp.lat;
        clientLngRef.current = jp.lng;
        setClientLat(jp.lat);
        setClientLng(jp.lng);
        return;
      }
      // Fallback: geocode from job posting address or profile address
      const street = jp?.streetAddress || jp?.street;
      const city = jp?.city;
      const state = jp?.state;
      const zipCode = jp?.zipCode;
      const coords = await geocodeAddress(`client_${uid}`, street, city, state, zipCode);
      if (coords) {
        clientLatRef.current = coords.lat;
        clientLngRef.current = coords.lng;
        setClientLat(coords.lat);
        setClientLng(coords.lng);
        db.collection('job_postings').doc(uid)
          .set({ lat: coords.lat, lng: coords.lng }, { merge: true })
          .catch(() => {});
      }
    } catch { /* best effort */ }
  };

  // Recalculate distances for caregivers that already have coords when client location resolves
  useEffect(() => {
    if (clientLat === null || clientLng === null) return;
    setCaregivers(prev => prev.map(cg => {
      if (cg.lat != null && cg.lng != null) {
        const dist = haversineDistance(clientLat, clientLng, cg.lat, cg.lng);
        return { ...cg, distance: Math.round(dist * 10) / 10 };
      }
      return cg;
    }));
  }, [clientLat, clientLng]);

  // Geocode caregivers without stored coords — runs as soon as caregivers load
  useEffect(() => {
    const needsGeocode = caregivers.filter(cg => cg.lat == null && (cg.street || cg.city));
    if (!needsGeocode.length) return;

    let cancelled = false;
    (async () => {
      for (const cg of needsGeocode) {
        if (cancelled) break;
        const coords = await geocodeAddress(cg.id, cg.street, cg.city, cg.state, cg.zipCode);
        if (coords && !cancelled) {
          setCaregivers(prev => prev.map(c => {
            if (c.id !== cg.id) return c;
            const lat = clientLatRef.current;
            const lng = clientLngRef.current;
            const dist = lat != null && lng != null
              ? Math.round(haversineDistance(lat, lng, coords.lat, coords.lng) * 10) / 10
              : 0;
            return { ...c, lat: coords.lat, lng: coords.lng, distance: dist };
          }));
        }
        if (!coords?.cached) await new Promise(r => setTimeout(r, 1100)); // Nominatim: 1 req/sec, skip if cached
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caregivers.length]);

  const loadClientDataAndCaregivers = async () => {
    try {
      const user = auth.currentUser;
      if (!user) {
        navigate('/login');
        return;
      }

      const intakeDoc = await db.collection('clientIntakes').doc(user.uid).get();
      let intakeData = null;
      if (intakeDoc.exists) {
        intakeData = intakeDoc.data();
        setClientIntakeData(intakeData);
      }

      dbService.getJobPostsByClient(user.uid).then(posts => {
        setClientOpenPosts(posts.filter((p: any) => p.status === 'open').map((p: any) => ({ id: p.id, title: p.title, startDate: p.startDate || p.date })));
      }).catch(() => {});

      await fetchCaregivers(intakeData);
      await fetchFavorites();
      resolveClientLocation(user.uid); // fire-and-forget; updates distances when resolved
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCaregivers = async (intakeData: any) => {
    try {
      const user = auth.currentUser;
      const precomputedData = user ? await dbService.getClientMatches(user.uid) : null;
      const precomputedMatches = precomputedData?.topMatches || [];
      const matchMap = new Map(precomputedMatches.map((m) => [m.caregiverId, m]));

      const [usersSnap, caregiversSnap] = await Promise.all([
        db.collection('users').where('role', '==', 'caregiver').limit(100).get(),
        db.collection('caregivers').limit(100).get().catch(() => null),
      ]);

      const seen = new Set<string>();
      const caregiverList: Caregiver[] = [];

      const pushDoc = (doc: firebase.firestore.DocumentSnapshot) => {
        if (seen.has(doc.id)) return;
        const data = doc.data() || {};
        const firstName = data.firstName || data.name?.split(' ')[0] || '';
        const lastName = data.lastName || data.name?.split(' ').slice(1).join(' ') || '';
        if (!firstName && !lastName && !data.name) return;
        seen.add(doc.id);
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
          distance: data.distance ?? 0,
          lat: data.lat ?? data.latitude ?? data.location?.lat ?? data._geoloc?.lat,
          lng: data.lng ?? data.longitude ?? data.location?.lng ?? data._geoloc?.lng,
          photoURL: data.photoURL || data.imageUrl || data.profilePhoto,
          hasReliableTransportation: data.hasTransportation || data.hasReliableTransportation || false,
          skills: data.skills || data.specializations || data.specialties || [],
          certifications: data.certifications || [],
          languages: data.languages || ['English'],
          experience: data.experience || data.yearsExperience || 0,
          bio: data.bio || data.about || '',
          lastActive: data.lastActive || new Date().toISOString(),
          repeatFamilies: data.repeatFamilies ?? 0,
          availability: Array.isArray(data.availability) ? data.availability : [],
        });
      };

      usersSnap.forEach(pushDoc);
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
      } else if (intakeData && caregiverList.length > 0) {
        const batchSize = 10;
        const processed: (Caregiver & { matchScore?: AIMatchScore })[] = [];
        for (let i = 0; i < caregiverList.length; i += batchSize) {
          const batch = caregiverList.slice(i, i + batchSize);
          const results = await Promise.all(
            batch.map(async (caregiver) => {
              try {
                const matchScorePromise = getAIMatches(
                  {
                    id: 0,
                    firstName: intakeData.careRecipient?.firstName || '',
                    lastName: intakeData.careRecipient?.lastName || '',
                    needs: intakeData.tasks ? Object.keys(intakeData.tasks).filter(k =>
                      Array.isArray(intakeData.tasks[k]) && intakeData.tasks[k].length > 0
                    ) : [],
                    schedule: intakeData.schedule || {},
                    location: intakeData.location || {},
                  },
                  caregiver,
                  intakeData
                );
                const timeoutPromise = new Promise<null>((_, reject) =>
                  setTimeout(() => reject(new Error('Timeout')), 2000)
                );
                const matchScore = await Promise.race([matchScorePromise, timeoutPromise]);
                return { ...caregiver, matchScore };
              } catch {
                return caregiver;
              }
            })
          );
          processed.push(...results);
        }
        caregiversWithScores = processed;
      }

      setCaregivers(caregiversWithScores);
    } catch (error) {
      console.error('Error fetching caregivers:', error);
    }
  };

  const fetchFavorites = async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      const userDoc = await db.collection('users').doc(user.uid).get();
      setFavorites((userDoc.data() as any)?.savedCaregiverIds || []);
    } catch {
      // non-critical
    }
  };

  const toggleFavorite = async (caregiverId: string) => {
    try {
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

  const openChat = async (caregiverId: string, caregiverName: string) => {
    try {
      const currentUid = auth.currentUser?.uid;
      const currentName = auth.currentUser?.displayName
        || auth.currentUser?.email?.split('@')[0]
        || 'Client';
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
    setMaxDistance(25);
    setMaxRate(75);
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
    if (maxDistance < 25) n++;
    if (maxRate < 75) n++;
    if (minRating > 0) n++;
    if (minExperience > 0) n++;
    if (verifiedOnly) n++;
    if (transportationOnly) n++;
    n += selectedSpecialties.size;
    n += selectedLanguages.size;
    return n;
  }, [nameQuery, maxDistance, maxRate, minRating, minExperience, verifiedOnly, transportationOnly, selectedSpecialties, selectedLanguages]);

  const filteredCaregivers = useMemo(() => {
    let list = caregivers.filter(cg => {
      if (showFavoritesOnly && !favorites.includes(cg.id)) return false;
      if (nameQuery) {
        const q = nameQuery.toLowerCase();
        const name = `${cg.firstName} ${cg.lastName}`.toLowerCase();
        if (!name.includes(q)) return false;
      }
      if (cg.distance > maxDistance) return false;
      if (cg.hourlyRate > maxRate) return false;
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
      case 'distance':
        sorted.sort((a, b) => a.distance - b.distance);
        break;
      case 'experience':
        sorted.sort((a, b) => (b.experience || 0) - (a.experience || 0));
        break;
      case 'best-match':
      default:
        sorted.sort((a, b) => (b.matchScore?.overallScore || 0) - (a.matchScore?.overallScore || 0));
        break;
    }
    return sorted;
  }, [caregivers, favorites, showFavoritesOnly, nameQuery, maxDistance, maxRate, minRating, minExperience, verifiedOnly, transportationOnly, selectedSpecialties, selectedLanguages, sortBy]);

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
      {/* Name search */}
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Name</label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Caregiver name"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Distance */}
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

      {/* Rate per hour */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Max Rate</label>
          <span className="text-xs text-slate-600 font-medium">up to ${maxRate}/hr</span>
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
            <p className="text-slate-500 mt-1 text-sm">
              {clientIntakeData
                ? 'Personalized matches based on your care plan'
                : 'Trusted caregivers, background-checked and ready to help'}
            </p>
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
                <option value="best-match">Best match</option>
                <option value="rating">Highest rated</option>
                <option value="price-low">Price: Low to High</option>
                <option value="price-high">Price: High to Low</option>
                <option value="distance">Nearest</option>
                <option value="experience">Most experienced</option>
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
                <option value="best-match">Best match</option>
                <option value="rating">Highest rated</option>
                <option value="price-low">Price: Low to High</option>
                <option value="price-high">Price: High to Low</option>
                <option value="distance">Nearest</option>
                <option value="experience">Most experienced</option>
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
                    onToggleFavorite={() => toggleFavorite(cg.id)}
                    onViewProfile={() => setViewingCaregiver(cg)}
                    onMessage={() => handleMessage(cg.id, `${cg.firstName} ${cg.lastName}`.trim())}
                    onRequestInterview={() => handleRequestInterview(cg)}
                    isBestMatch={sortBy === 'best-match' && index === 0 && !!cg.matchScore}
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
          onSuccess={() => setInterviewCaregiver(null)}
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
  onToggleFavorite: () => void;
  onViewProfile: () => void;
  onMessage: () => void;
  onRequestInterview: () => void;
}

const CaregiverCard: React.FC<CaregiverCardProps> = ({
  caregiver, isFavorite, isBestMatch, onToggleFavorite, onViewProfile, onMessage, onRequestInterview,
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
            <Heart className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
            <span className="text-[17px]">{caregiver.experience || 0} experience</span>
          </div>
          <div className="flex items-center gap-3.5 text-slate-700">
            <MapPin className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
            <span className="text-[17px]">
              {caregiver.lat != null && caregiver.distance > 0
                ? `${caregiver.distance} miles away`
                : (caregiver.city || 'Nearby')}
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
         <button
            onClick={(e) => { e.stopPropagation(); onRequestInterview(); }}
            className="w-full py-2 text-sm font-bold bg-primary-600 border-2 border-primary-600 text-white rounded-xl hover:bg-primary-700 hover:border-primary-700 transition-colors inline-flex items-center justify-center gap-1.5"
         >
            <Video className="w-4 h-4" /> Request Interview
         </button>
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
