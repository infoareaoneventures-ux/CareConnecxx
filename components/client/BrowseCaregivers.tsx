import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Search, Filter, Star, MapPin, Clock, DollarSign, 
  MessageSquare, User, Heart, Shield, ChefHat, Brain, 
  Accessibility, Pill, Car, Home, Sparkles
} from 'lucide-react';
import { Button } from '../ui/Button';
import { authService } from '../../services/api';
import { db } from '../../lib/firebase';
import { logMatchSignal } from '../../services/matchFeedback';
import { ClientNavigation } from './ClientNavigation';
import { CreditCardBadge } from '../shared/CreditCardBadge';
import { CaregiverVerificationBadges } from '../shared/CaregiverVerificationBadges';
import { useCareConnex } from '../../context/CareConnexContext';
import { useAccessGates } from '../../hooks/useAccessGates';

interface Caregiver {
  id: string;
  name: string;
  imageUrl?: string;
  rating: number;
  yearsExperience: number;
  hourlyRate: number;
  isTopRated?: boolean;
  isFavorite?: boolean;
  specialties: string[];
  location: string;
  bio?: string;
  availability: string;
}

type FilterTab = 'All' | 'Personal Care' | 'Meal Preparation' | 'Dementia Care' | 'Medication' | 'Transportation';

const filterTabs: FilterTab[] = ['All', 'Personal Care', 'Meal Preparation', 'Dementia Care', 'Medication', 'Transportation'];

const specialtyIcons: Record<string, React.ReactNode> = {
  'Personal Care': <Heart className="w-4 h-4" />,
  'Meal Preparation': <ChefHat className="w-4 h-4" />,
  'Dementia Care': <Brain className="w-4 h-4" />,
  'Medication Reminders': <Pill className="w-4 h-4" />,
  'Transportation': <Car className="w-4 h-4" />,
  'Mobility Assistance': <Accessibility className="w-4 h-4" />,
  'Companionship': <User className="w-4 h-4" />,
  'Housekeeping': <Home className="w-4 h-4" />,
};

export const BrowseCaregivers: React.FC = () => {
  const navigate = useNavigate();
  const { addToast, blockedIds } = useCareConnex();
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [filteredCaregivers, setFilteredCaregivers] = useState<Caregiver[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterTab>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const { gate, Modals: GateModals } = useAccessGates();

  useEffect(() => {
    let isMounted = true;
    const loadCaregivers = async () => {
      const fdb = db;
      if (!fdb) return;
      try {
        const snap = await fdb.collection('publicCaregiverProfiles')
          .orderBy('rating', 'desc')
          .limit(40)
          .get();
        if (!isMounted) return;
        const uid = authService.getCurrentUser()?.uid;
        // Load saved favorites for this user
        let savedFavs: Set<string> = new Set();
        if (uid) {
          const userDoc = await fdb.collection('users').doc(uid).get();
          const favs: string[] = userDoc.data()?.savedCaregivers || [];
          savedFavs = new Set(favs);
        }
        const list: Caregiver[] = snap.docs.map(doc => {
          const d = doc.data();
          const fullName = d.name || `${d.firstName || ''} ${d.lastName || ''}`.trim() || 'Caregiver';
          const city = d.city || d.location?.city || '';
          const state = d.state || d.location?.state || '';
          const location = city ? `${city}${state ? `, ${state}` : ''}` : (d.location || '');
          return {
            id: doc.id,
            name: fullName,
            imageUrl: d.photoURL || d.imageUrl || d.profilePhoto,
            rating: d.rating ?? 0,
            yearsExperience: d.yearsExperience ?? 0,
            hourlyRate: d.hourlyRate ?? 0,
            isTopRated: (d.rating ?? 0) >= 4.8,
            isFavorite: savedFavs.has(doc.id),
            specialties: d.specializations || d.specialties || [],
            location,
            availability: d.isAvailable ? 'Available' : 'Unavailable',
            bio: d.bio || d.about || '',
          };
        });
        setCaregivers(list);
        // Apply the block filter from the moment the list is set so blocked
        // caregivers never flash before the filtering effect runs.
        setFilteredCaregivers(list.filter(cg => !blockedIds.has(cg.id)));
      } catch (err) {
        console.error('Error loading caregivers:', err);
        if (isMounted) addToast('Could not load caregivers. Please try again.', 'error');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    loadCaregivers();
    return () => { isMounted = false; };
  }, []);

  // Filter caregivers when tab, search, or blocked list changes
  useEffect(() => {
    let filtered = caregivers.filter(cg => !blockedIds.has(cg.id));

    // Apply specialty filter
    if (activeFilter !== 'All') {
      filtered = filtered.filter(cg => 
        cg.specialties.some(s => 
          s.toLowerCase().includes(activeFilter.toLowerCase()) ||
          (activeFilter === 'Medication' && s.includes('Medication')) ||
          (activeFilter === 'Transportation' && s.includes('Transportation'))
        )
      );
    }

    // Apply search filter
    if (searchQuery) {
      filtered = filtered.filter(cg =>
        cg.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        cg.specialties.some(s => s.toLowerCase().includes(searchQuery.toLowerCase()))
      );
    }

    setFilteredCaregivers(filtered);
  }, [activeFilter, searchQuery, caregivers, blockedIds]);

  // Load identity check status
  const toggleFavorite = (caregiverId: string) => {
    setFavorites(prev => {
      const newFavorites = new Set(prev);
      if (newFavorites.has(caregiverId)) {
        newFavorites.delete(caregiverId);
        addToast('Removed from favorites', 'info');
      } else {
        newFavorites.add(caregiverId);
        addToast('Added to favorites', 'success');
        logMatchSignal(caregiverId, 'favorited');
      }
      return newFavorites;
    });
  };

  const openChat = (caregiverId: string, caregiverName: string) => {
    const currentUid = authService.getCurrentUser()?.uid;
    if (!currentUid) { navigate('/client/inbox'); return; }
    const currentName = authService.getCurrentUser()?.displayName || authService.getCurrentUser()?.email?.split('@')[0] || 'Client';
    const sorted = [currentUid, caregiverId].sort();
    const roomId = sorted.join('_');
    const names = sorted.map(id => id === currentUid ? currentName : caregiverName);
    logMatchSignal(caregiverId, 'messaged');
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

  const handleViewProfile = (caregiverId: string) => {
    navigate(`/client/caregiver/${caregiverId}`);
  };

  const renderStars = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    
    return (
      <div className="flex items-center space-x-0.5">
        {[...Array(5)].map((_, i) => (
          <Star
            key={i}
            className={`w-3.5 h-3.5 ${
              i < fullStars
                ? 'text-yellow-400 fill-yellow-400'
                : i === fullStars && hasHalfStar
                ? 'text-yellow-400 fill-yellow-400/50'
                : 'text-gray-300'
            }`}
          />
        ))}
        <span className="ml-1 text-sm font-semibold text-gray-700">{rating}</span>
      </div>
    );
  };

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

  return (
    <div className="min-h-screen bg-gray-50">
      <ClientNavigation />
      
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-32">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Browse Caregivers</h1>
          <p className="text-gray-600 mt-2">
            Find and connect with qualified caregivers in your area
          </p>
        </div>

        {/* Search Bar */}
        <div className="relative mb-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name or specialty..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-transparent shadow-sm"
          />
        </div>

        {/* Filter Tabs */}
        <div className="flex flex-wrap gap-2 mb-8">
          {filterTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveFilter(tab)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                activeFilter === tab
                  ? 'bg-primary-600 text-white shadow-md'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Results Count */}
        <div className="mb-4 text-sm text-gray-500">
          Showing {filteredCaregivers.length} caregiver{filteredCaregivers.length !== 1 ? 's' : ''}
        </div>

        {/* Caregiver Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredCaregivers.map((caregiver) => (
            <div
              key={caregiver.id}
              className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow"
            >
              <div className="p-5">
                {/* Top Section: Photo and Favorite */}
                <div className="flex items-start justify-between mb-4">
                  <div className="relative">
                    {caregiver.imageUrl ? (
                      <img
                        src={caregiver.imageUrl}
                        alt={caregiver.name}
                        className="w-20 h-20 rounded-full object-cover border-4 border-white shadow-md"
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-full border-4 border-white shadow-md bg-gradient-to-br from-primary-100 to-primary-200 flex items-center justify-center">
                        <span className="text-2xl font-bold text-primary-600 select-none">
                          {caregiver.name.split(' ').map((p: string) => p[0]).slice(0, 2).join('').toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => toggleFavorite(caregiver.id)}
                    className={`p-2 rounded-full transition-colors ${
                      favorites.has(caregiver.id)
                        ? 'text-red-500 bg-red-50'
                        : 'text-gray-400 hover:text-red-500 hover:bg-red-50'
                    }`}
                  >
                    <Heart className={`w-5 h-5 ${favorites.has(caregiver.id) ? 'fill-current' : ''}`} />
                  </button>
                </div>

                {/* Name and Rating */}
                <div className="mb-3">
                  <h2 className="text-xl font-bold text-gray-900">{caregiver.name}</h2>
                  <p className="text-sm text-gray-500">Caregiver</p>
                  <div className="mt-1">{renderStars(caregiver.rating)}</div>
                  <div className="mt-2">
                    <CreditCardBadge show={!!(caregiver as any).acceptsCreditCards} />
                  </div>
                  <CaregiverVerificationBadges verified={(caregiver as any).verified} backgroundCheckStatus={(caregiver as any).backgroundCheckStatus} className="mt-2" />
                </div>

                {/* Stats Row */}
                <div className="flex items-center justify-between py-3 border-t border-b border-gray-100 mb-3">
                  <div className="flex items-center space-x-1 text-sm text-gray-600">
                    <Clock className="w-4 h-4 text-primary-600" />
                    <span><span className="font-semibold text-gray-900">{caregiver.yearsExperience}</span> years exp.</span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <span className="text-lg font-bold text-primary-600">${caregiver.hourlyRate}</span>
                    <span className="text-sm text-gray-500">/hr</span>
                  </div>
                </div>

                {/* Location & Availability */}
                <div className="space-y-2 mb-4">
                  <div className="flex items-center space-x-2 text-sm text-gray-600">
                    <MapPin className="w-4 h-4 text-gray-400" />
                    <span>{caregiver.location}</span>
                  </div>
                  <div className="flex items-center space-x-2 text-sm text-green-600">
                    <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                    <span>{caregiver.availability}</span>
                  </div>
                </div>

                {/* Specialties */}
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {caregiver.specialties.slice(0, 3).map((specialty) => (
                    <span
                      key={specialty}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-primary-50 text-primary-700"
                    >
                      {specialtyIcons[specialty] || <Shield className="w-3 h-3" />}
                      {specialty}
                    </span>
                  ))}
                  {caregiver.specialties.length > 3 && (
                    <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                      +{caregiver.specialties.length - 3}
                    </span>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex space-x-3">
                  <Button
                    onClick={() => handleMessage(caregiver.id, caregiver.name)}
                    className="flex-1 bg-primary-600 hover:bg-primary-700 text-white text-sm"
                  >
                    <MessageSquare className="w-4 h-4 mr-1.5" />
                    Message
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleViewProfile(caregiver.id)}
                    className="flex-1 border-gray-300 text-gray-700 hover:bg-gray-50 text-sm"
                  >
                    <User className="w-4 h-4 mr-1.5" />
                    View Profile
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Empty State */}
        {filteredCaregivers.length === 0 && (
          <div className="text-center py-16">
            <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Search className="w-10 h-10 text-gray-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No caregivers found</h3>
            <p className="text-gray-600 mb-6">Try adjusting your filters or search query.</p>
            <Button onClick={() => { setActiveFilter('All'); setSearchQuery(''); }}>
              Clear Filters
            </Button>
          </div>
        )}
      </main>

      <GateModals />
    </div>
  );
};

export default BrowseCaregivers;
