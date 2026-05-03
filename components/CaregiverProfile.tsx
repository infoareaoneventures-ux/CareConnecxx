import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ChevronLeft, ShieldCheck, Star, Home, Loader2, FileText,
  Lock, Trash2, CheckCircle, AlertTriangle, X, MapPin, Link,
  Copy, LogOut
} from 'lucide-react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Badge } from './ui/Badge';
import { AvatarUpload } from './ui/AvatarUpload';
import { DocumentUpload } from './ui/DocumentUpload';
import { ViewType, AddToastFunction, Review, Caregiver, CaregiverDocument } from '../types';
import { dbService, authService } from '../services/api';
import { BackgroundCheckModal } from './BackgroundCheckModal';
import { documentUploadService, DocumentType } from '../services/documentUpload';
import { CaregiverTopNav } from './caregiver/CaregiverTopNav';
import { ProfileApprovalBanner } from './caregiver/ProfileApprovalBanner';
import { LookingForSection } from './caregiver/LookingForSection';

interface CaregiverProfileProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
}

const SERVICES = [
  'Companion Care', 'Personal Care', 'Memory Care', 'Mobility Assistance',
  'Medication Reminders', 'Post-Surgery Recovery', 'Household Support',
];

const CERTIFICATIONS = ['CNA', 'HHA', 'CPR/First Aid', 'Home Health Aide', 'Dementia Care Specialist'];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PERIODS = ['Morning', 'Afternoon', 'Evening'];
const LANGUAGES = ['English', 'Spanish', 'French', 'Mandarin', 'Vietnamese', 'Tagalog'];

export const CaregiverProfile: React.FC<CaregiverProfileProps> = ({ onNavigate, onShowToast }) => {
  const [activeTab, setActiveTab] = useState<'summary' | 'reviews' | 'documents' | 'security'>('summary');
  const [loading, setLoading] = useState(true);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [profile, setProfile] = useState<Partial<Caregiver> & { bio?: string; experience?: number }>({
    name: '',
    imageUrl: '',
    hourlyRate: 0,
    bio: '',
    experience: 0,
    verified: false,
    backgroundCheckStatus: 'none',
  });

  // Inline-edit state
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editBio, setEditBio] = useState('');
  const [editRate, setEditRate] = useState(0);
  const [editRateTwo, setEditRateTwo] = useState(0);
  const [editRateThree, setEditRateThree] = useState(0);
  const [editServices, setEditServices] = useState<string[]>([]);
  const [editCerts, setEditCerts] = useState<string[]>([]);
  const [editLocation, setEditLocation] = useState('');
  const [editRadius, setEditRadius] = useState(10);
  const [editLanguages, setEditLanguages] = useState<string[]>(['English']);
  const [editAvailability, setEditAvailability] = useState<Record<string, string[]>>({});

  // Modal state
  const [showCheckModal, setShowCheckModal] = useState(false);
  const [previewDocument, setPreviewDocument] = useState<CaregiverDocument | null>(null);

  // Security state
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const currentUser = authService.getCurrentUser();

  useEffect(() => {
    let unsubscribeReviews: (() => void) | undefined;

    const fetchData = async () => {
      try {
        let fetchedProfile: Caregiver | undefined;

        if (currentUser) {
          const userData = await dbService.getUser(currentUser.uid);
          if (userData) {
            fetchedProfile = userData as unknown as Caregiver;
          }
        }

        if (fetchedProfile) {
          setProfile(prev => ({
            ...fetchedProfile!,
            bio: fetchedProfile?.bio || '',
            experience: fetchedProfile?.experience || 0,
            hourlyRate: fetchedProfile?.hourlyRate || prev.hourlyRate || 25,
            imageUrl: fetchedProfile?.photo || fetchedProfile?.imageUrl || prev.imageUrl,
          }));

          // Seed editable fields
          setEditBio(fetchedProfile.bio || '');
          setEditRate(fetchedProfile.hourlyRate || 25);
          setEditRateTwo((fetchedProfile as any).rateForTwo || (fetchedProfile.hourlyRate || 25) + 5);
          setEditRateThree((fetchedProfile as any).rateForThree || (fetchedProfile.hourlyRate || 25) + 10);
          setEditServices((fetchedProfile as any).services || []);
          setEditCerts((fetchedProfile as any).certifications || []);
          setEditLocation((fetchedProfile as any).location || '');
          setEditRadius((fetchedProfile as any).serviceRadius || 10);
          setEditLanguages((fetchedProfile as any).languages || ['English']);
          setEditAvailability((fetchedProfile as any).weeklyAvailability || {});
        }

        const reviewId = fetchedProfile?.uid || fetchedProfile?.id || currentUser?.uid;
        if (reviewId) {
          unsubscribeReviews = dbService.subscribeToReviews(reviewId, (fetchedReviews) => {
            setReviews(fetchedReviews);
          });
        }
      } catch (error) {
        console.error('Error fetching caregiver profile:', error);
        onShowToast('Failed to load profile data', 'error');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    return () => { if (unsubscribeReviews) unsubscribeReviews(); };
  }, [currentUser]);

  const averageRating = useMemo(() =>
    reviews.length > 0
      ? (reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1)
      : '5.0'
  , [reviews]);

  const docSummary = useMemo(() =>
    documentUploadService.getDocumentStatusSummary(profile.documents)
  , [profile.documents]);

  // Save helper — writes to Firestore and merges into local state
  const saveSection = useCallback(async (data: Record<string, any>) => {
    if (currentUser) {
      try {
        await dbService.updateUser('caregivers', currentUser.uid, data);
        setProfile(prev => ({ ...prev, ...data }));
        onShowToast('Profile updated', 'success');
      } catch {
        onShowToast('Failed to update', 'error');
        return;
      }
    } else {
      setProfile(prev => ({ ...prev, ...data }));
      onShowToast('Updated (Demo Mode)', 'success');
    }
    setEditingSection(null);
  }, [currentUser, onShowToast]);

  const handleDocumentUpload = useCallback(async (file: File, type: DocumentType) => {
    const userId = currentUser?.uid;
    if (!userId) { onShowToast('Please log in to upload documents', 'error'); return; }
    try {
      const doc = await documentUploadService.uploadDocument(userId, file, type);
      setProfile(prev => ({ ...prev, documents: { ...prev.documents, [type]: doc } }));
      onShowToast(`${documentUploadService.getDocumentTypeName(type)} uploaded successfully`, 'success');
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'Upload failed', 'error');
      throw error;
    }
  }, [currentUser, onShowToast]);

  const handleDocumentDelete = useCallback(async (type: DocumentType) => {
    const userId = currentUser?.uid;
    if (!userId) return;
    const doc = profile.documents?.[type];
    if (!doc?.path) return;
    try {
      await documentUploadService.deleteDocument(userId, type, doc.path);
      setProfile(prev => ({ ...prev, documents: { ...prev.documents, [type]: undefined } }));
      onShowToast('Document removed', 'info');
    } catch { onShowToast('Failed to remove document', 'error'); }
  }, [currentUser, profile.documents, onShowToast]);

  const handleImageUpdate = useCallback(async (url: string) => {
    setProfile(prev => ({ ...prev, photo: url, imageUrl: url }));
    // Auto-save so the photo persists without requiring a manual section save
    if (currentUser) {
      try {
        await dbService.updateUser('caregivers', currentUser.uid, { photo: url });
      } catch {
        onShowToast('Photo saved locally but failed to sync — try again', 'error');
      }
    }
  }, [currentUser, onShowToast]);

  const handleLogout = useCallback(async () => {
    await authService.logout();
    onShowToast('Logged out successfully', 'info');
    onNavigate('landing');
  }, [onNavigate, onShowToast]);

  const handlePasswordChange = useCallback(async () => {
    if (newPassword !== confirmPassword) { onShowToast('Passwords do not match', 'error'); return; }
    try {
      await authService.updateUserPassword(newPassword);
      onShowToast('Password updated successfully', 'success');
      setNewPassword(''); setConfirmPassword('');
    } catch { onShowToast('Failed to update password', 'error'); }
  }, [newPassword, confirmPassword, onShowToast]);

  const handleDeleteAccount = useCallback(async () => {
    if (confirm('Are you sure you want to delete your account?')) {
      try {
        await authService.deleteUserAccount();
        onShowToast('Account deleted', 'info');
        onNavigate('landing');
      } catch { onShowToast('Failed to delete account', 'error'); }
    }
  }, [onNavigate, onShowToast]);

  const toggleAvailability = (day: string, period: string) => {
    setEditAvailability(prev => {
      const current = prev[day] || [];
      const updated = current.includes(period)
        ? current.filter(p => p !== period)
        : [...current, period];
      return { ...prev, [day]: updated };
    });
  };

  const profileUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/caregiver/${currentUser?.uid || 'preview'}`
    : '';

  // Derived display values
  const displayServices: string[] = (profile as any).services ?? editServices;
  const displayCerts: string[] = (profile as any).certifications ?? editCerts;
  const displayLocation: string = (profile as any).location ?? editLocation;
  const displayRadius: number = (profile as any).serviceRadius ?? editRadius;
  const displayAvailability: Record<string, string[]> = (profile as any).weeklyAvailability ?? editAvailability;
  const displayLanguages: string[] = (profile as any).languages ?? editLanguages;

  if (loading) return (
    <div className="flex justify-center p-10">
      <Loader2 className="animate-spin text-primary-500 w-8 h-8" />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 pb-24 animate-slide-in">
      <CaregiverTopNav />

      <div className="max-w-5xl mx-auto px-4 py-6">

        {/* Page header (mobile shows back button, desktop gets nav from TopNav) */}
        <div className="flex items-center justify-between mb-4 md:hidden">
          <div className="flex items-center">
            <button
              onClick={() => onNavigate('caregiver')}
              className="p-2 -ml-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <h1 className="text-2xl font-bold text-slate-900 ml-2">My Profile</h1>
          </div>
        </div>

        <ProfileApprovalBanner
          profile={profile as any}
          onViewChecklist={() => setActiveTab('documents')}
        />

      {/* Profile hero card */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-6">
        <div className="bg-gradient-to-r from-primary-500 to-primary-600 h-24" />
        <div className="px-6 pb-5">
          <div className="flex items-end justify-between -mt-10 mb-4">
            <div className="w-20 h-20 rounded-full border-4 border-white bg-white overflow-hidden shadow-md flex-shrink-0">
              <AvatarUpload
                currentUrl={profile.photo || profile.imageUrl}
                onImageSelected={handleImageUpdate}
                userId={currentUser?.uid}
                storageFolder="caregivers"
              />
            </div>
            {!profile.verified && (
              <button
                onClick={() => setActiveTab('documents')}
                className="mb-1 text-xs bg-accent-100 text-accent-700 px-3 py-1.5 rounded-full font-medium hover:bg-accent-200 transition-colors"
              >
                Get Approved
              </button>
            )}
          </div>
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-1.5">
                {profile.name}
                {profile.verified && <ShieldCheck className="w-5 h-5 text-blue-500" fill="currentColor" />}
              </h2>
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500 mt-0.5">
                <span className="flex items-center gap-1">
                  <Star className="w-3.5 h-3.5 text-accent-400" fill="currentColor" />
                  <span className="font-medium text-slate-700">{averageRating}</span>
                  <span>({reviews.length} reviews)</span>
                </span>
                {displayLocation && (
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" />
                    {displayLocation}
                  </span>
                )}
                <span className="font-semibold text-primary-600">${profile.hourlyRate || editRate}/hr</span>
              </div>
            </div>
            {profile.verified
              ? <Badge variant="success">Verified</Badge>
              : <Badge variant="neutral">Pending</Badge>
            }
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-6">
        {(['summary', 'reviews', 'documents', 'security'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium capitalize transition-all relative ${
              activeTab === tab ? 'bg-white text-primary-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab}
            {tab === 'documents' && docSummary.pending > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-accent-500 text-white text-xs rounded-full flex items-center justify-center">
                {docSummary.pending}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── SUMMARY TAB ── */}
      {activeTab === 'summary' && (
        <div className="lg:flex lg:gap-6">

          {/* Left: editable sections */}
          <div className="flex-1 space-y-4">

            <LookingForSection profile={profile as any} />

            <div className="bg-white border border-slate-200 rounded-2xl p-5 flex items-center justify-between">
              <div>
                <p className="font-bold text-slate-900">Intro video</p>
                <p className="text-xs text-slate-500">Say hello in 30 seconds — caregivers with videos get more than twice as many jobs.</p>
              </div>
              <button
                onClick={() => onNavigate('caregiver-video')}
                className="text-sm font-semibold text-accent-600 hover:text-accent-700"
              >
                {(profile as any).introVideoUrl ? 'Replace video →' : 'Add a new video →'}
              </button>
            </div>

            {/* Availability */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-slate-900">Availability</h3>
                {editingSection === 'availability' ? (
                  <div className="flex gap-3">
                    <button onClick={() => setEditingSection(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                    <button
                      onClick={() => saveSection({ weeklyAvailability: editAvailability })}
                      className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                    >Save</button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditAvailability(displayAvailability); setEditingSection('availability'); }}
                    className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                  >Edit</button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <td className="pr-3 pb-2 text-slate-400 font-medium w-24" />
                      {DAYS.map(d => (
                        <td key={d} className="text-center pb-2 text-slate-600 font-semibold min-w-[36px]">{d}</td>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {PERIODS.map(period => (
                      <tr key={period}>
                        <td className="pr-3 py-1.5 text-slate-500 font-medium whitespace-nowrap">{period}</td>
                        {DAYS.map(day => {
                          const source = editingSection === 'availability' ? editAvailability : displayAvailability;
                          const available = (source[day] || []).includes(period);
                          return (
                            <td key={day} className="text-center py-1.5">
                              {editingSection === 'availability' ? (
                                <button
                                  onClick={() => toggleAvailability(day, period)}
                                  className={`w-6 h-6 rounded-full mx-auto transition-all ${
                                    available ? 'bg-primary-500' : 'bg-slate-100 hover:bg-primary-100'
                                  }`}
                                />
                              ) : (
                                <div className={`w-5 h-5 rounded-full mx-auto ${available ? 'bg-primary-500' : 'bg-slate-100'}`} />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* About */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">About {(profile.name || '').split(' ')[0]}</h3>
                {editingSection === 'about' ? (
                  <div className="flex gap-3">
                    <button onClick={() => setEditingSection(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                    <button
                      onClick={() => saveSection({ bio: editBio, languages: editLanguages })}
                      className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                    >Save</button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditBio(profile.bio || ''); setEditLanguages(displayLanguages); setEditingSection('about'); }}
                    className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                  >Edit</button>
                )}
              </div>
              {editingSection === 'about' ? (
                <div className="space-y-4">
                  <textarea
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-400 min-h-[110px] resize-none"
                    value={editBio}
                    onChange={e => setEditBio(e.target.value)}
                    placeholder="Tell families about your experience and approach to care..."
                  />
                  <div>
                    <p className="text-xs font-medium text-slate-600 mb-2">Languages</p>
                    <div className="flex flex-wrap gap-2">
                      {LANGUAGES.map(lang => (
                        <button
                          key={lang}
                          onClick={() => setEditLanguages(prev =>
                            prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang]
                          )}
                          className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                            editLanguages.includes(lang)
                              ? 'bg-primary-50 border-primary-400 text-primary-700 font-medium'
                              : 'border-slate-200 text-slate-500 hover:border-slate-300'
                          }`}
                        >
                          {lang}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-slate-600 leading-relaxed mb-3">
                    {profile.bio
                      ? profile.bio
                      : <span className="text-slate-400 italic">Add a bio to introduce yourself to families.</span>
                    }
                  </p>
                  {displayLanguages.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {displayLanguages.map(lang => (
                        <span key={lang} className="text-xs bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">{lang}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Services */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">Services</h3>
                {editingSection === 'services' ? (
                  <div className="flex gap-3">
                    <button onClick={() => setEditingSection(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                    <button
                      onClick={() => saveSection({ services: editServices })}
                      className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                    >Save</button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditServices(displayServices); setEditingSection('services'); }}
                    className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                  >Edit</button>
                )}
              </div>
              {editingSection === 'services' ? (
                <div className="grid grid-cols-2 gap-2">
                  {SERVICES.map(service => (
                    <button
                      key={service}
                      onClick={() => setEditServices(prev =>
                        prev.includes(service) ? prev.filter(s => s !== service) : [...prev, service]
                      )}
                      className={`text-sm px-3 py-2.5 rounded-xl border text-left transition-all flex items-center gap-2 ${
                        editServices.includes(service)
                          ? 'bg-primary-50 border-primary-400 text-primary-700 font-medium'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${
                        editServices.includes(service) ? 'bg-primary-500 border-primary-500' : 'border-slate-300'
                      }`}>
                        {editServices.includes(service) && <CheckCircle className="w-3 h-3 text-white" />}
                      </div>
                      {service}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {displayServices.length > 0
                    ? displayServices.map((s: string) => (
                        <span key={s} className="text-sm bg-primary-50 text-primary-700 px-3 py-1.5 rounded-full font-medium">{s}</span>
                      ))
                    : <p className="text-sm text-slate-400 italic">No services added yet. Tap Edit to add.</p>
                  }
                </div>
              )}
            </div>

            {/* Experience & Rates */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">Experience &amp; Rates</h3>
                {editingSection === 'experience' ? (
                  <div className="flex gap-3">
                    <button onClick={() => setEditingSection(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                    <button
                      onClick={() => saveSection({ hourlyRate: editRate, rateForTwo: editRateTwo, rateForThree: editRateThree })}
                      className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                    >Save</button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setEditRate(profile.hourlyRate || 25);
                      setEditRateTwo((profile as any).rateForTwo || (profile.hourlyRate || 25) + 5);
                      setEditRateThree((profile as any).rateForThree || (profile.hourlyRate || 25) + 10);
                      setEditingSection('experience');
                    }}
                    className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                  >Edit</button>
                )}
              </div>
              {editingSection === 'experience' ? (
                <div>
                  <p className="text-xs text-slate-500 mb-3">Set your hourly rates by number of seniors</p>
                  <div className="grid grid-cols-3 gap-3">
                    {([
                      { label: '1 Senior', value: editRate, setter: setEditRate },
                      { label: '2 Seniors', value: editRateTwo, setter: setEditRateTwo },
                      { label: '3+ Seniors', value: editRateThree, setter: setEditRateThree },
                    ] as { label: string; value: number; setter: (v: number) => void }[]).map(({ label, value, setter }) => (
                      <div key={label}>
                        <label className="text-xs text-slate-500 block mb-1">{label}</label>
                        <div className="flex items-center border border-slate-200 rounded-xl overflow-hidden">
                          <span className="px-2 py-2.5 text-slate-400 text-sm bg-slate-50 border-r border-slate-200">$</span>
                          <input
                            type="number"
                            className="flex-1 py-2.5 px-2 text-sm focus:outline-none min-w-0"
                            value={value}
                            min={15}
                            max={200}
                            onChange={e => setter(Math.max(0, Number(e.target.value)))}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-0 divide-y divide-slate-100">
                  {[
                    { label: '1 Senior', rate: profile.hourlyRate || editRate },
                    { label: '2 Seniors', rate: (profile as any).rateForTwo || editRateTwo },
                    { label: '3+ Seniors', rate: (profile as any).rateForThree || editRateThree },
                  ].map(({ label, rate }) => (
                    <div key={label} className="flex items-center justify-between py-2.5">
                      <span className="text-sm text-slate-600">{label}</span>
                      <span className="text-sm font-bold text-slate-900">${rate}/hr</span>
                    </div>
                  ))}
                  {(profile.experience ?? 0) > 0 && (
                    <p className="text-xs text-slate-500 pt-2.5">{profile.experience} years of experience</p>
                  )}
                </div>
              )}
            </div>

            {/* Background */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">Background</h3>
                {editingSection === 'background' ? (
                  <div className="flex gap-3">
                    <button onClick={() => setEditingSection(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                    <button
                      onClick={() => saveSection({ certifications: editCerts })}
                      className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                    >Save</button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditCerts(displayCerts); setEditingSection('background'); }}
                    className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                  >Edit</button>
                )}
              </div>
              {editingSection === 'background' ? (
                <div className="grid grid-cols-2 gap-2">
                  {CERTIFICATIONS.map(cert => (
                    <button
                      key={cert}
                      onClick={() => setEditCerts(prev =>
                        prev.includes(cert) ? prev.filter(c => c !== cert) : [...prev, cert]
                      )}
                      className={`text-sm px-3 py-2.5 rounded-xl border text-left transition-all flex items-center gap-2 ${
                        editCerts.includes(cert)
                          ? 'bg-primary-50 border-primary-400 text-primary-700 font-medium'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${
                        editCerts.includes(cert) ? 'bg-primary-500 border-primary-500' : 'border-slate-300'
                      }`}>
                        {editCerts.includes(cert) && <CheckCircle className="w-3 h-3 text-white" />}
                      </div>
                      {cert}
                    </button>
                  ))}
                </div>
              ) : (
                <div>
                  {displayCerts.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {displayCerts.map((c: string) => (
                        <span key={c} className="text-sm bg-blue-50 text-blue-700 px-3 py-1.5 rounded-full font-medium flex items-center gap-1.5">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          {c}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 italic">No certifications added. Tap Edit to add.</p>
                  )}
                  {profile.verified && (
                    <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-green-500" />
                      <span className="text-sm text-slate-600">Background check passed</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Location */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">Locations</h3>
                {editingSection === 'location' ? (
                  <div className="flex gap-3">
                    <button onClick={() => setEditingSection(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
                    <button
                      onClick={() => saveSection({ location: editLocation, serviceRadius: editRadius })}
                      className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                    >Save</button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditLocation(displayLocation); setEditRadius(displayRadius); setEditingSection('location'); }}
                    className="text-xs text-primary-600 font-semibold hover:text-primary-700"
                  >Edit</button>
                )}
              </div>
              {editingSection === 'location' ? (
                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">City / Neighborhood</label>
                    <input
                      type="text"
                      className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-400"
                      value={editLocation}
                      onChange={e => setEditLocation(e.target.value)}
                      placeholder="e.g. Miami, FL"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-2">Willing to work within (miles)</label>
                    <div className="flex flex-wrap gap-2">
                      {[5, 10, 15, 25, 50].map(r => (
                        <button
                          key={r}
                          onClick={() => setEditRadius(r)}
                          className={`text-sm px-3 py-1.5 rounded-full border transition-all ${
                            editRadius === r
                              ? 'bg-primary-50 border-primary-400 text-primary-700 font-medium'
                              : 'border-slate-200 text-slate-500 hover:border-slate-300'
                          }`}
                        >
                          {r} mi
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {displayLocation ? (
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                      <MapPin className="w-4 h-4 text-primary-500 flex-shrink-0" />
                      Lives in {displayLocation}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 italic">Location not set. Tap Edit to add.</p>
                  )}
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <MapPin className="w-4 h-4 text-slate-300 flex-shrink-0" />
                    Willing to work within {displayRadius} miles
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* Right: Sidebar */}
          <div className="lg:w-72 mt-4 lg:mt-0 space-y-4 flex-shrink-0">

            {/* Get Recommendations */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="w-10 h-10 bg-primary-50 rounded-xl flex items-center justify-center mb-3">
                <Star className="w-5 h-5 text-primary-600" />
              </div>
              <h3 className="font-bold text-slate-900 text-sm mb-1">Get Recommendations</h3>
              <p className="text-xs text-slate-500 leading-relaxed mb-4">
                Share your profile with families you've worked with to get reviews and stand out from other caregivers.
              </p>
              <div className="bg-slate-50 rounded-xl p-3 mb-3 overflow-hidden">
                <p className="text-xs text-slate-400 mb-1">Your profile link</p>
                <p className="text-xs font-mono text-slate-600 truncate">{profileUrl}</p>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(profileUrl).catch(() => {});
                  onShowToast('Link copied!', 'success');
                }}
                className="w-full text-sm font-semibold bg-primary-500 hover:bg-primary-600 text-white py-2.5 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                <Copy className="w-4 h-4" />
                Copy Profile Link
              </button>
            </div>

            {/* Profile Completeness */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <h3 className="font-bold text-slate-900 text-sm mb-3">Profile Completeness</h3>
              {(() => {
                const checks = [
                  !!(profile.photo || profile.imageUrl),
                  (profile.bio?.length ?? 0) >= 50,
                  displayServices.length > 0,
                  (profile.hourlyRate ?? 0) > 0,
                  !!displayLocation,
                  Object.values(displayAvailability).some(slots => slots.length > 0),
                ];
                const done = checks.filter(Boolean).length;
                const pct = Math.round((done / checks.length) * 100);
                return (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-slate-500">{done} of {checks.length} complete</span>
                      <span className="text-xs font-bold text-primary-600">{pct}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary-500 rounded-full transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {pct < 100 && (
                      <p className="text-xs text-slate-400 mt-2">Complete your profile to attract more families.</p>
                    )}
                  </>
                );
              })()}
            </div>

          </div>
        </div>
      )}

      {/* ── REVIEWS TAB ── */}
      {activeTab === 'reviews' && (
        <div className="space-y-4">
          {reviews.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
              <Star className="w-10 h-10 text-slate-200 mx-auto mb-3" />
              <p className="font-semibold text-slate-700 mb-1">No reviews yet</p>
              <p className="text-sm text-slate-400">Reviews from families will appear here after completed jobs.</p>
            </div>
          ) : (
            reviews.map(review => (
              <div key={review.id} className="bg-white border border-slate-200 rounded-2xl p-5">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold flex-shrink-0">
                    {(review.clientName || 'F').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-semibold text-slate-900 text-sm">{review.clientName || 'Family'}</p>
                      <div className="flex">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star key={i} className={`w-3.5 h-3.5 ${i < review.rating ? 'text-accent-400' : 'text-slate-200'}`} fill="currentColor" />
                        ))}
                      </div>
                    </div>
                    <p className="text-sm text-slate-600 leading-relaxed">{review.comment}</p>
                    {review.date && (
                      <p className="text-xs text-slate-400 mt-2">
                        {new Date(review.date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── DOCUMENTS TAB ── */}
      {activeTab === 'documents' && (
        <div className="space-y-6">
          {!profile.verified && (
            <div className={`p-4 rounded-xl flex items-start gap-4 ${
              profile.verificationStatus === 'submitted' || profile.backgroundCheckStatus === 'pending'
                ? 'bg-blue-50 border border-blue-200'
                : 'bg-slate-50 border border-slate-200'
            }`}>
              <div className={`p-2 rounded-full ${
                profile.verificationStatus === 'submitted' || profile.backgroundCheckStatus === 'pending'
                  ? 'bg-blue-100' : 'bg-slate-200'
              }`}>
                <AlertTriangle className="w-6 h-6 text-slate-500" />
              </div>
              <div className="flex-grow">
                <h4 className="font-bold text-slate-900">
                  {profile.verificationStatus === 'submitted' || profile.backgroundCheckStatus === 'pending'
                    ? 'Pending Admin Approval'
                    : 'Verification Required'}
                </h4>
                <p className="text-sm text-slate-600 mt-1">
                  {profile.verificationStatus === 'submitted' || profile.backgroundCheckStatus === 'pending'
                    ? 'Your account is under review. Documents below show current status.'
                    : 'Complete verification to start accepting jobs.'}
                </p>
                {profile.verificationStatus !== 'submitted' && profile.backgroundCheckStatus !== 'pending' && (
                  <Button size="sm" onClick={() => setShowCheckModal(true)} className="mt-3 bg-slate-900 text-white">
                    Start Verification
                  </Button>
                )}
              </div>
            </div>
          )}

          {docSummary.total > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h4 className="font-bold text-slate-900 mb-3">Document Status</h4>
              <div className="flex flex-wrap gap-3">
                {docSummary.approved > 0 && (
                  <span className="text-green-600 flex items-center gap-1 text-sm bg-green-50 px-3 py-1 rounded-full">
                    <CheckCircle className="w-4 h-4" />{docSummary.approved} Approved
                  </span>
                )}
                {docSummary.pending > 0 && (
                  <span className="text-accent-600 flex items-center gap-1 text-sm bg-accent-50 px-3 py-1 rounded-full">
                    <Loader2 className="w-4 h-4 animate-spin" />{docSummary.pending} Pending Review
                  </span>
                )}
                {docSummary.rejected > 0 && (
                  <span className="text-red-600 flex items-center gap-1 text-sm bg-red-50 px-3 py-1 rounded-full">
                    <AlertTriangle className="w-4 h-4" />{docSummary.rejected} Rejected
                  </span>
                )}
              </div>
              {docSummary.rejected > 0 && (
                <p className="text-xs text-red-600 mt-2">
                  Rejected documents can be re-uploaded below. Check the notes for correction instructions.
                </p>
              )}
            </div>
          )}

          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-900 flex items-center">
                <FileText className="w-5 h-5 mr-2 text-primary-500" /> Required Documents
              </h3>
              <span className="text-xs text-slate-500">Upload clear images or PDFs</span>
            </div>
            <div className="space-y-4">
              <DocumentUpload
                type="driversLicense"
                label="Driver's License (Front)"
                description="Required for all caregivers who provide transportation"
                existingDocument={profile.documents?.driversLicense}
                onUpload={handleDocumentUpload}
                onDelete={handleDocumentDelete}
              />
              <DocumentUpload
                type="registration"
                label="Vehicle Registration"
                description="Current vehicle registration document"
                existingDocument={profile.documents?.registration}
                onUpload={handleDocumentUpload}
                onDelete={handleDocumentDelete}
              />
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
            <h4 className="text-sm font-bold text-blue-900 mb-1">Why we need these documents</h4>
            <p className="text-xs text-blue-700">
              These documents help us ensure the safety of our clients and verify that you meet our transportation requirements.
              All documents are securely stored and only accessible to authorized administrators.
            </p>
          </div>
        </div>
      )}

      {/* ── SECURITY TAB ── */}
      {activeTab === 'security' && (
        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 mb-6">
          <h3 className="font-bold text-slate-900 mb-4 flex items-center">
            <Lock className="w-5 h-5 mr-2 text-primary-500" /> Security Settings
          </h3>
          <div className="space-y-4 mb-8 border-b border-slate-100 pb-8">
            <h4 className="text-sm font-bold text-slate-700">Change Password</h4>
            <Input label="New Password" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            <Input label="Confirm Password" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
            <Button variant="accent" onClick={handlePasswordChange} disabled={!newPassword}>Update Password</Button>
          </div>
          <div>
            <h4 className="text-sm font-bold text-red-600 mb-2">Danger Zone</h4>
            <p className="text-sm text-slate-500 mb-4">Deleting your account is permanent.</p>
            <button
              onClick={handleDeleteAccount}
              className="flex items-center text-red-500 hover:text-red-700 font-medium border border-red-200 hover:bg-red-50 px-4 py-2 rounded-xl transition-all"
            >
              <Trash2 className="w-4 h-4 mr-2" /> Delete Account
            </button>
          </div>
        </div>
      )}

      {/* Nav footer */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden mt-6">
        <button
          onClick={() => onNavigate('caregiver')}
          className="w-full p-4 text-left flex items-center text-slate-700 hover:bg-slate-50 transition-colors font-medium border-b border-slate-100"
        >
          <Home className="w-5 h-5 mr-3 text-slate-400" />
          Return to Dashboard
        </button>
        <button
          onClick={handleLogout}
          className="w-full p-4 text-left flex items-center text-red-500 hover:bg-red-50 transition-colors font-medium"
        >
          <LogOut className="w-5 h-5 mr-3" />
          Log Out
        </button>
      </div>

      {showCheckModal && (
        <BackgroundCheckModal onClose={() => setShowCheckModal(false)} onShowToast={onShowToast} />
      )}

      </div>

      {previewDocument && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setPreviewDocument(null)}
        >
          <div
            className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-bold text-slate-900">Document Preview</h3>
              <button onClick={() => setPreviewDocument(null)} className="p-2 hover:bg-slate-100 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 flex justify-center bg-slate-50">
              {previewDocument.fileType?.startsWith('image/') ? (
                <img src={previewDocument.url} alt="Document" className="max-h-[60vh] rounded-lg shadow-lg" />
              ) : (
                <div className="text-center py-12">
                  <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-600">PDF Document</p>
                  <a href={previewDocument.url} target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:underline text-sm mt-2 inline-block">
                    Open in new tab
                  </a>
                </div>
              )}
            </div>
            <div className="p-4 border-t bg-slate-50">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600">Status: <span className="font-medium capitalize">{previewDocument.status}</span></span>
                <span className="text-slate-500">Uploaded: {new Date(previewDocument.uploadedAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
