import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Heart, MapPin, Star, CheckCircle, Sparkles, TrendingUp,
  MessageSquare, Shield, Clock, Search, SlidersHorizontal, X,
  ChevronDown, BookmarkPlus, Languages, Award,
  Pill, Car, Brain, Activity, Users,
} from 'lucide-react';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { getAIMatches, AIMatchScore } from '../services/aiMatchingService';
import { dbService } from '../services/api';
import { logMatchSignal } from '../services/matchFeedback';
import { ClientNavigation } from './client/ClientNavigation';
import { CreditCardBadge } from './shared/CreditCardBadge';
import { chatService } from '../services/chatService';
import { useAccessGates } from '../hooks/useAccessGates';

interface Caregiver {
  id: string;
  firstName: string;
  lastName: string;
  hourlyRate: number;
  rating: number;
  reviewCount?: number;
  city: string;
  verified: boolean;
  backgroundCheckStatus?: 'none' | 'pending' | 'clear' | 'flagged' | 'consider';
  distance: number;
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
  { key: 'Dementia Care', icon: Brain },
  { key: 'Alzheimer\'s Care', icon: Brain },
  { key: 'Parkinson\'s Care', icon: Activity },
  { key: 'Hospice & Palliative', icon: Heart },
  { key: 'Post-Surgery Recovery', icon: Activity },
  { key: 'Mobility Assistance', icon: Activity },
  { key: 'Personal Care (ADLs)', icon: Users },
  { key: 'Medication Reminders', icon: Pill },
  { key: 'Transportation', icon: Car },
  { key: 'Companionship', icon: Heart },
  { key: 'Meal Preparation', icon: Users },
  { key: 'Light Housekeeping', icon: Users },
];

const CERTIFICATIONS = ['CNA', 'HHA', 'CPR Certified', 'First Aid', 'RN', 'LPN'];
const LANGUAGES = ['English', 'Spanish', 'Mandarin', 'Tagalog', 'Vietnamese', 'Korean', 'Russian', 'Arabic'];
const EXPERIENCE_TIERS = [
  { key: 0, label: 'Any experience' },
  { key: 1, label: '1+ years' },
  { key: 3, label: '3+ years' },
  { key: 5, label: '5+ years' },
  { key: 10, label: '10+ years' },
];

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

  // Filters
  const [nameQuery, setNameQuery] = useState('');
  const [maxDistance, setMaxDistance] = useState(25);
  const [maxRate, setMaxRate] = useState(75);
  const [minRating, setMinRating] = useState(0);
  const [minExperience, setMinExperience] = useState(0);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [transportationOnly, setTransportationOnly] = useState(false);
  const [selectedSpecialties, setSelectedSpecialties] = useState<Set<string>>(new Set());
  const [selectedCerts, setSelectedCerts] = useState<Set<string>>(new Set());
  const [selectedLanguages, setSelectedLanguages] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadClientDataAndCaregivers();
  }, []);

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

      await fetchCaregivers(intakeData);
      await fetchFavorites();
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
          verified: data.backgroundCheckComplete || data.verified || false,
          backgroundCheckStatus: data.backgroundCheckStatus || data.backgroundCheckData?.status || (data.backgroundCheckComplete || data.verified ? 'clear' : 'none'),
          distance: data.distance ?? 0,
          photoURL: data.photoURL || data.imageUrl || data.profilePhoto,
          hasReliableTransportation: data.hasReliableTransportation || false,
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
      const favDoc = await db.collection('favorites').doc(user.uid).get();
      if (favDoc.exists) {
        setFavorites(favDoc.data()?.caregiverIds || []);
      }
    } catch (error) {
      console.error('Error fetching favorites:', error);
    }
  };

  const toggleFavorite = async (caregiverId: string) => {
    try {
      const user = auth.currentUser;
      if (!user) { navigate('/login'); return; }
      const favRef = db.collection('favorites').doc(user.uid);
      const isFav = favorites.includes(caregiverId);
      if (isFav) {
        await favRef.update({
          caregiverIds: firebase.firestore.FieldValue.arrayRemove(caregiverId),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        setFavorites(prev => prev.filter(id => id !== caregiverId));
      } else {
        await favRef.set({
          caregiverIds: firebase.firestore.FieldValue.arrayUnion(caregiverId),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
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

  const handleRequestBooking = (caregiverId: string, caregiverName: string) => {
    gate('booking', caregiverName, () => navigate(`/client/book/${caregiverId}`));
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
    setSelectedCerts(new Set());
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
    n += selectedCerts.size;
    n += selectedLanguages.size;
    return n;
  }, [nameQuery, maxDistance, maxRate, minRating, minExperience, verifiedOnly, transportationOnly, selectedSpecialties, selectedCerts, selectedLanguages]);

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
      if (selectedCerts.size > 0) {
        const certSet = new Set((cg.certifications || []).map(c => c.toLowerCase()));
        let hasAny = false;
        selectedCerts.forEach(c => { if (certSet.has(c.toLowerCase())) hasAny = true; });
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
  }, [caregivers, favorites, showFavoritesOnly, nameQuery, maxDistance, maxRate, minRating, minExperience, verifiedOnly, transportationOnly, selectedSpecialties, selectedCerts, selectedLanguages, sortBy]);

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
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Minimum Rating</label>
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

      {/* Certifications */}
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Certifications</label>
        <div className="flex flex-wrap gap-1.5">
          {CERTIFICATIONS.map(cert => (
            <button
              key={cert}
              onClick={() => toggleSetItem(selectedCerts, cert, setSelectedCerts)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                selectedCerts.has(cert)
                  ? 'bg-primary-600 border-primary-600 text-white'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {cert}
            </button>
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
          <button className="hidden sm:inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:border-primary-500 hover:text-primary-600 transition-colors">
            <BookmarkPlus className="w-4 h-4" />
            Save search
          </button>
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
                onPostJob={() => navigate('/client/dashboard')}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredCaregivers.map((cg, index) => (
                  <CaregiverCard
                    key={cg.id}
                    caregiver={cg}
                    isFavorite={favorites.includes(cg.id)}
                    onToggleFavorite={() => toggleFavorite(cg.id)}
                    onViewProfile={() => navigate(`/client/caregiver/${cg.id}`, { state: { caregiverData: cg } })}
                    onMessage={() => handleMessage(cg.id, `${cg.firstName} ${cg.lastName}`.trim())}
                    onRequestBooking={() => handleRequestBooking(cg.id, `${cg.firstName} ${cg.lastName}`.trim())}
                    isBestMatch={sortBy === 'best-match' && index === 0 && !!cg.matchScore}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

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
  onRequestBooking: () => void;
}

const CaregiverCard: React.FC<CaregiverCardProps> = ({
  caregiver, isFavorite, isBestMatch, onToggleFavorite, onViewProfile, onMessage, onRequestBooking,
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
            
            <div className="flex items-center gap-2">
              {/* IDV Badge */}
              <div className="w-9 h-9 rounded-full bg-teal-500 flex flex-col items-center justify-center text-white pt-1">
                <Shield className="w-4 h-4 mb-0.5" />
                <span className="text-[7px] font-bold leading-none tracking-wider uppercase">IDV</span>
              </div>
              
              {/* BGC Badge */}
              {caregiver.backgroundCheckStatus === 'clear' ? (
                <div className="w-9 h-9 rounded-full bg-blue-500 flex flex-col items-center justify-center text-white pt-1" title="Background Check Cleared">
                  <CheckCircle className="w-4 h-4 mb-0.5" />
                  <span className="text-[7px] font-bold leading-none tracking-wider uppercase">BGC+</span>
                </div>
              ) : (
                <div className="w-9 h-9 rounded-full bg-yellow-400 flex flex-col items-center justify-center text-white pt-1" title="Background Check Pending">
                  <Clock className="w-4 h-4 mb-0.5" />
                  <span className="text-[7px] font-bold leading-none tracking-wider uppercase">BGC</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Details section */}
        <div className="space-y-3.5 mb-5 mt-1">
          <div className="flex items-center gap-3.5 text-slate-700">
            <Heart className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
            <span className="text-[17px]">{caregiver.experience || 0} years experience</span>
          </div>
          <div className="flex items-center gap-3.5 text-slate-700">
            <MapPin className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
            <span className="text-[17px]">{caregiver.distance} miles</span>
          </div>
        </div>

        {/* Skills pill tags */}
        {(caregiver.skills && caregiver.skills.length > 0) ? (
          <div className="flex flex-wrap gap-2 mb-6 mt-1">
            {caregiver.skills.slice(0, 3).map(skill => (
              <span key={skill} className="px-3.5 py-1.5 bg-slate-100 border border-slate-200 text-slate-800 text-[13px] font-medium rounded-[1rem]">
                {skill}
              </span>
            ))}
          </div>
        ) : (
          <div className="mb-6 mt-1"></div>
        )}

        {/* SitterCity-style Footer block: Responds in / Last Login */}
        <div className="border-t border-slate-200 pt-4 pb-2 flex items-center justify-between mt-auto">
          <div className="flex-1 text-center border-r border-slate-200 pr-2 pb-1">
            <div className="flex items-center justify-center gap-1.5 text-slate-500 mb-1">
              <MessageSquare className="w-3.5 h-3.5" />
              <span className="text-[10px] font-bold uppercase tracking-[0.08em]">Responds in</span>
            </div>
            <p className="text-[16px] text-slate-900 tracking-tight">30 minutes</p>
          </div>
          <div className="flex-1 text-center pl-2 pb-1">
            <div className="flex items-center justify-center gap-1.5 text-slate-500 mb-1">
              <Clock className="w-3.5 h-3.5" />
              <span className="text-[10px] font-bold uppercase tracking-[0.08em]">Last Login</span>
            </div>
            <p className="text-[16px] text-slate-900 tracking-tight">Online now</p>
          </div>
        </div>

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
            onClick={(e) => { e.stopPropagation(); onRequestBooking(); }}
            className="w-full py-2 text-sm font-bold bg-primary-600 border-2 border-primary-600 text-white rounded-xl hover:bg-primary-700 hover:border-primary-700 transition-colors"
         >
            Book
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
        Post a Job
      </button>
    </div>
  </div>
);
