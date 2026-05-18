import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, MapPin, Star, Filter, X, User, CheckCircle, Clock, Play, Briefcase, Heart, GraduationCap, Navigation, Zap, Bookmark } from 'lucide-react';
import { CaregiverVerificationBadges } from '../shared/CaregiverVerificationBadges';
import { Button } from '../ui/Button';
import { Caregiver } from '../../types';
import { dbService, authService } from '../../services/api';
import { db } from '../../lib/firebase';


function formatLastActive(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `active ${mins < 2 ? 'just now' : `${mins} min ago`}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `active ${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `active ${days} day${days !== 1 ? 's' : ''} ago`;
}

interface CaregiverSearchProps {
  onSelectCaregiver: (caregiver: Caregiver) => void;
  onShowToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  onPostJob?: () => void;
}


const SENIOR_CONDITIONS = [
  "Alzheimer's/Dementia",
  "Parkinson's",
  'Stroke Recovery',
  'Fall Risk',
  'Hospice Care',
  'Diabetes',
  'COPD',
  'Wheelchair/Mobility',
  'Medication Management',
  'Post-Surgery Recovery',
];

const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const CaregiverSearch: React.FC<CaregiverSearchProps> = ({
  onSelectCaregiver,
  onShowToast,
  onPostJob,
}) => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [loading, setLoading] = useState(false);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [filters, setFilters] = useState({
    minRating: 0,
    maxRate: 0,
    verifiedOnly: true,
    conditions: [] as string[],
  });
  const [showFilters, setShowFilters] = useState(false);
  const [showSaveSearch, setShowSaveSearch] = useState(false);
  const [saveSearchName, setSaveSearchName] = useState('');
  const [saveSearchFreq, setSaveSearchFreq] = useState<'daily' | 'weekly' | 'off'>('weekly');
  const [savingSearch, setSavingSearch] = useState(false);

  useEffect(() => {
    loadCaregivers();
    loadSaved();
  }, []);

  const loadSaved = async () => {
    const user = authService.getCurrentUser();
    if (!user?.uid) return;
    try {
      const profile = await dbService.getUser(user.uid);
      setSavedIds((profile as any)?.savedCaregiverIds || []);
    } catch {}
  };

  const toggleSave = async (e: React.MouseEvent, caregiverId: string) => {
    e.stopPropagation();
    const user = authService.getCurrentUser();
    if (!user?.uid) return;
    const next = savedIds.includes(caregiverId)
      ? savedIds.filter(id => id !== caregiverId)
      : [...savedIds, caregiverId];
    setSavedIds(next);
    try {
      await dbService.updateUser('users', user.uid, { savedCaregiverIds: next } as any);
    } catch {
      setSavedIds(savedIds); // revert on error
    }
  };

  const loadCaregivers = async () => {
    setLoading(true);
    try {
      const { caregivers: data } = await dbService.getCaregivers(20, null);
      setCaregivers(data);
    } catch (error) {
      console.error('Failed to load caregivers:', error);
      onShowToast?.('Failed to load caregivers', 'error');
    } finally {
      setLoading(false);
    }
  };

  const toggleFilter = (key: 'conditions', value: string) => {
    setFilters(prev => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter(v => v !== value)
        : [...prev[key], value],
    }));
  };

  const handleSaveSearch = async () => {
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    setSavingSearch(true);
    const newSearch = {
      name: saveSearchName || 'My Search',
      filters: { ...filters, searchTerm },
      emailFrequency: saveSearchFreq,
      savedAt: new Date().toISOString(),
    };
    try {
      const userRef = db.collection('users').doc(user.uid);
      const doc = await userRef.get();
      const existing = (doc.data() as any)?.savedSearches || [];
      await userRef.update({ savedSearches: [...existing, newSearch] });
      onShowToast?.('Search saved!', 'success');
      setShowSaveSearch(false);
      setSaveSearchName('');
    } catch {
      onShowToast?.('Could not save search', 'error');
    } finally {
      setSavingSearch(false);
    }
  };

  const filteredCaregivers = caregivers.filter(cg => {
    const matchesSearch =
      !searchTerm ||
      cg.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cg.bio?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cg.skills?.some((s: string) => s.toLowerCase().includes(searchTerm.toLowerCase()));

    const matchesRating = (cg.rating || 0) >= filters.minRating;
    const matchesVerified = !filters.verifiedOnly || cg.verified;
    const matchesRate = !filters.maxRate || (cg.hourlyRate || 0) <= filters.maxRate;

    const matchesConditions =
      filters.conditions.length === 0 ||
      filters.conditions.some(c => cg.skills?.includes(c));

    return matchesSearch && matchesRating && matchesVerified && matchesRate && matchesConditions;
  });

  const activeFilterCount =
    (filters.minRating > 0 ? 1 : 0) +
    (filters.maxRate > 0 ? 1 : 0) +
    (!filters.verifiedOnly ? 1 : 0) +
    filters.conditions.length;

  const goToPostJob = () => navigate('/client/post-job');

  return (
    <>
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-primary-600 to-primary-700 p-6 text-white">
        <h2 className="text-2xl font-bold mb-1">Find Senior Caregivers</h2>
        <p className="text-primary-100 text-sm">
          {caregivers.length > 0 ? `${caregivers.length} verified caregivers in Santa Clara County` : 'Searching Santa Clara County...'}
        </p>
      </div>

      {/* Search Bar */}
      <div className="p-4 border-b border-slate-200 bg-slate-50">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Search by name, condition, or skill..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl bg-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
              showFilters || activeFilterCount > 0
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
            }`}
          >
            <Filter className="w-4 h-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="bg-primary-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowSaveSearch(true)}
            title="Save this search"
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:border-primary-300 hover:text-primary-600 transition-colors"
          >
            <Bookmark className="w-4 h-4" />
            Save
          </button>
        </div>

        {/* Filter Panel */}
        {showFilters && (
          <div className="mt-4 p-4 bg-white rounded-xl border border-slate-200 space-y-5">
            {/* Row 1: Rating + Rate + Verified */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Min Rating</label>
                <select
                  value={filters.minRating}
                  onChange={e => setFilters({ ...filters, minRating: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                >
                  <option value={0}>Any</option>
                  <option value={4}>4+ Stars</option>
                  <option value={4.5}>4.5+ Stars</option>
                  <option value={4.8}>4.8+ Stars</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Max Rate</label>
                <select
                  value={filters.maxRate}
                  onChange={e => setFilters({ ...filters, maxRate: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                >
                  <option value={0}>Any</option>
                  <option value={25}>Up to $25/hr</option>
                  <option value={30}>Up to $30/hr</option>
                  <option value={35}>Up to $35/hr</option>
                  <option value={40}>Up to $40/hr</option>
                </select>
              </div>
              <div className="flex items-end pb-0.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.verifiedOnly}
                    onChange={e => setFilters({ ...filters, verifiedOnly: e.target.checked })}
                    className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
                  />
                  <span className="text-sm text-slate-700">Verified only</span>
                </label>
              </div>
            </div>

            {/* Senior Conditions */}
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 block">Senior Care Experience</label>
              <div className="flex flex-wrap gap-2">
                {SENIOR_CONDITIONS.map(cond => (
                  <button
                    key={cond}
                    onClick={() => toggleFilter('conditions', cond)}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                      filters.conditions.includes(cond)
                        ? 'bg-accent-500 border-accent-500 text-white'
                        : 'bg-white border-slate-200 text-slate-600 hover:border-accent-300'
                    }`}
                  >
                    {cond}
                  </button>
                ))}
              </div>
            </div>

            {activeFilterCount > 0 && (
              <button
                onClick={() => setFilters({ minRating: 0, maxRate: 0, verifiedOnly: true, conditions: [] })}
                className="text-xs text-primary-600 hover:text-primary-800 font-medium"
              >
                Clear all filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="p-4">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
        ) : filteredCaregivers.length === 0 ? (
          <div className="text-center py-12">
            <User className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-600 font-medium mb-1">No caregivers found</p>
            <p className="text-slate-400 text-sm mb-4">Try adjusting your filters or post a job for caregivers to apply</p>
            <Button onClick={() => goToPostJob()} className="bg-primary-600 hover:bg-primary-700 text-white">
              Post a Job
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-500 mb-4">
              <span className="font-semibold text-slate-700">{filteredCaregivers.length}</span> caregiver{filteredCaregivers.length !== 1 ? 's' : ''} available
            </p>

            <div className="space-y-3">
              {filteredCaregivers.map((caregiver, index) => (
                <React.Fragment key={caregiver.id}>
                  {/* Post a Job CTA — injected after every 6 cards */}
                  {index > 0 && index % 6 === 0 && (
                    <div className="p-4 bg-primary-50 border border-primary-200 rounded-xl flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                          <Briefcase className="w-5 h-5 text-primary-600" />
                        </div>
                        <div>
                          <p className="font-semibold text-primary-900 text-sm">Can't find the right match?</p>
                          <p className="text-primary-700 text-xs">Post a job — caregivers apply to you</p>
                        </div>
                      </div>
                      <button
                        onClick={() => goToPostJob()}
                        className="bg-primary-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors"
                      >
                        Post a Job
                      </button>
                    </div>
                  )}

                  {/* Caregiver Card */}
                  <div
                    className="p-4 bg-white rounded-xl hover:bg-slate-50 transition-colors cursor-pointer border border-slate-200 hover:border-primary-300 hover:shadow-sm"
                    onClick={() => onSelectCaregiver(caregiver)}
                  >
                    <div className="flex items-start gap-4">
                      {/* Avatar with optional video indicator */}
                      <div className="relative flex-shrink-0">
                        <div className="w-16 h-16 bg-primary-100 rounded-full overflow-hidden">
                          {caregiver.photo || caregiver.imageUrl ? (
                            <img
                              src={caregiver.photo || caregiver.imageUrl}
                              alt={caregiver.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <User className="w-8 h-8 text-primary-600" />
                            </div>
                          )}
                        </div>
                        {/* Video play button if video exists */}
                        {(caregiver as any).videoUrl && (
                          <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-accent-500 rounded-full flex items-center justify-center shadow">
                            <Play className="w-3 h-3 text-white fill-white" />
                          </div>
                        )}
                        {/* Heart/Favorite button */}
                        <button
                          onClick={e => toggleSave(e, caregiver.id)}
                          className="absolute -top-1 -right-1 w-6 h-6 bg-white rounded-full flex items-center justify-center shadow border border-slate-100"
                        >
                          <Heart className={`w-3.5 h-3.5 ${savedIds.includes(caregiver.id) ? 'fill-rose-500 text-rose-500' : 'text-slate-300'}`} />
                        </button>
                      </div>

                      {/* Main Info */}
                      <div className="flex-1 min-w-0">
                        {/* Name row */}
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-slate-900">{caregiver.name}</h3>
                          {caregiver.verified && (
                            <CheckCircle className="w-4 h-4 text-primary-500 flex-shrink-0" />
                          )}
                        </div>

                        {/* Rating + distance row */}
                        <div className="flex items-center gap-3 mb-1.5">
                          {caregiver.rating && (
                            <div className="flex items-center gap-1">
                              <Star className="w-3.5 h-3.5 text-accent-400 fill-accent-400" />
                              <span className="text-sm font-medium text-slate-700">{caregiver.rating}</span>
                              {caregiver.reviewCount && (
                                <span className="text-xs text-slate-400">({caregiver.reviewCount})</span>
                              )}
                            </div>
                          )}
                          {caregiver.location && (
                            <div className="flex items-center gap-1 text-xs text-slate-500">
                              <MapPin className="w-3 h-3" />
                              <span>{caregiver.location}</span>
                              {caregiver.distance > 0 && (
                                <span className="text-slate-400">· {caregiver.distance} mi</span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Last active */}
                        {caregiver.lastActive && (
                          <div className="flex items-center gap-1 text-xs text-primary-600 mb-1.5">
                            <Zap className="w-3 h-3 fill-primary-500" />
                            {formatLastActive(caregiver.lastActive)}
                          </div>
                        )}

                        {/* College + travel radius */}
                        {(caregiver.education || caregiver.travelRadius) && (
                          <div className="flex items-center gap-3 mb-1.5">
                            {caregiver.education && (
                              <div className="flex items-center gap-1 text-xs text-slate-400">
                                <GraduationCap className="w-3 h-3" />
                                <span>{caregiver.education}</span>
                              </div>
                            )}
                            {caregiver.travelRadius && (
                              <div className="flex items-center gap-1 text-xs text-slate-400">
                                <Navigation className="w-3 h-3" />
                                <span>Works within {caregiver.travelRadius} mi</span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Trust badge row */}
                        <div className="flex flex-wrap items-center gap-1.5 mb-2">
                          <CaregiverVerificationBadges verified={caregiver.verified} backgroundCheckStatus={caregiver.backgroundCheckStatus} />
                          {(caregiver as any).covidVaccinated && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-50 border border-slate-200 rounded-full text-xs text-slate-600">
                              <CheckCircle className="w-3 h-3 text-primary-500" /> COVID Vaccinated
                            </span>
                          )}
                          {caregiver.paymentPreferences?.venmo && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700 font-medium">
                              Venmo
                            </span>
                          )}
                          {caregiver.paymentPreferences?.zelle && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700 font-medium">
                              Zelle
                            </span>
                          )}
                          {caregiver.paymentPreferences?.cash && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 border border-green-200 rounded-full text-xs text-green-700 font-medium">
                              Cash
                            </span>
                          )}
                          {!caregiver.paymentPreferences && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-50 border border-slate-200 rounded-full text-xs text-slate-500">
                              Cash · Venmo · Zelle
                            </span>
                          )}
                        </div>

                        {/* Repeat families count */}
                        {caregiver.repeatFamilies && caregiver.repeatFamilies > 0 && (
                          <p className="text-xs text-slate-500 mb-1.5">
                            Booked by <span className="font-semibold text-slate-700">{caregiver.repeatFamilies}</span> repeat families
                          </p>
                        )}

                        {/* Senior care specialties */}
                        {caregiver.skills && caregiver.skills.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-2">
                            {caregiver.skills.slice(0, 3).map((skill, i) => (
                              <span
                                key={i}
                                className="px-2 py-0.5 bg-accent-50 text-accent-700 text-xs rounded-full"
                              >
                                {skill}
                              </span>
                            ))}
                            {caregiver.skills.length > 3 && (
                              <span className="px-2 py-0.5 text-slate-400 text-xs">
                                +{caregiver.skills.length - 3} more
                              </span>
                            )}
                          </div>
                        )}

                        {/* Availability days */}
                        {caregiver.availability && caregiver.availability.length > 0 && (
                          <div className="flex items-center gap-1 mt-1">
                            <Clock className="w-3 h-3 text-slate-400" />
                            <div className="flex gap-1">
                              {DAYS_SHORT.map((day, i) => {
                                const isAvailable = caregiver.availability.some(
                                  a => a.toLowerCase().includes(DAYS_FULL[i].toLowerCase()) || a.toLowerCase() === day.toLowerCase()
                                );
                                return (
                                  <span
                                    key={day}
                                    className={`text-xs w-7 h-5 flex items-center justify-center rounded font-medium ${
                                      isAvailable
                                        ? 'bg-primary-100 text-primary-700'
                                        : 'bg-slate-100 text-slate-300'
                                    }`}
                                  >
                                    {day[0]}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Rate + CTA */}
                      <div className="flex flex-col items-end gap-3 flex-shrink-0">
                        {caregiver.hourlyRate > 0 && (
                          <div className="text-right">
                            <div>
                              <span className="text-xl font-bold text-slate-900">${caregiver.hourlyRate}</span>
                              <span className="text-xs text-slate-400">/hr</span>
                            </div>
                            {((caregiver as any).rateFor2Seniors || (caregiver as any).rateFor3PlusSeniors) && (
                              <div className="mt-1 space-y-0.5">
                                {(caregiver as any).rateFor2Seniors && (
                                  <p className="text-xs text-slate-500">${(caregiver as any).rateFor2Seniors}/hr × 2</p>
                                )}
                                {(caregiver as any).rateFor3PlusSeniors && (
                                  <p className="text-xs text-slate-500">${(caregiver as any).rateFor3PlusSeniors}/hr × 3+</p>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        <button
                          onClick={e => { e.stopPropagation(); onSelectCaregiver(caregiver); }}
                          className="bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                        >
                          View Profile
                        </button>
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              ))}

              {/* Bottom Post a Job CTA */}
              {filteredCaregivers.length > 0 && (
                <div className="mt-6 p-5 bg-gradient-to-r from-primary-50 to-accent-50 border border-primary-200 rounded-xl text-center">
                  <p className="font-semibold text-slate-800 mb-1">Don't see the right fit?</p>
                  <p className="text-slate-500 text-sm mb-3">Post a job and let qualified caregivers come to you</p>
                  <button
                    onClick={() => goToPostJob()}
                    className="bg-primary-600 text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-primary-700 transition-colors"
                  >
                    Post a Job — It's Free
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Save Search Modal */}
      {showSaveSearch && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-1">Save This Search</h3>
            <p className="text-sm text-slate-500 mb-4">Get notified when new caregivers match your filters.</p>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Search name</label>
                <input
                  type="text"
                  value={saveSearchName}
                  onChange={e => setSaveSearchName(e.target.value)}
                  placeholder="e.g. Dementia care near me"
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Email alerts</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['daily', 'weekly', 'off'] as const).map(freq => (
                    <button
                      key={freq}
                      onClick={() => setSaveSearchFreq(freq)}
                      className={`py-2 rounded-lg text-xs font-semibold border transition-colors capitalize ${
                        saveSearchFreq === freq
                          ? 'bg-primary-600 border-primary-600 text-white'
                          : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
                      }`}
                    >
                      {freq}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => setShowSaveSearch(false)}
                  className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSearch}
                  disabled={savingSearch}
                  className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50"
                >
                  {savingSearch ? 'Saving...' : 'Save Search'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
};

export default CaregiverSearch;
