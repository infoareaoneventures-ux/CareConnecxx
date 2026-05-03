import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronUp, ChevronDown, Check, X, Eye, EyeOff, Loader2,
} from 'lucide-react';
import { ClientNavigation } from './ClientNavigation';
import { PlanSelectModal } from './PlanSelectModal';
import { authService } from '../../services/api';
import { startIdentityVerification } from '../../services/stripeService';
import { auth, db } from '../../lib/firebase';
import { useCareConnex } from '../../context/CareConnexContext';

// ── Types ───────────────────────────────────────────────────────────────────
interface PersonalInfo  { firstName: string; lastName: string; email: string; phone: string; }
interface CareLocation  { address: string; city: string; state: string; zip: string; }
interface PasswordData  { currentPassword: string; newPassword: string; confirmPassword: string; }
interface CommPrefs     { newsletter: boolean; newMatches: boolean; caregiverReviews: boolean; }
interface SavedSearch   {
  name: string;
  filters: Record<string, any>;
  emailFrequency: 'daily' | 'weekly' | 'off';
  savedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const LABEL_W = 'w-40 flex-shrink-0';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-6 py-4 border-b border-slate-100 last:border-0">
      <span className={`${LABEL_W} text-sm text-slate-500 pt-1`}>{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function Section({
  title, open, onToggle, children,
}: {
  title: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden mb-4">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors"
      >
        <span className="font-semibold text-slate-900 text-base">{title}</span>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>
      {open && <div className="px-6 pb-6">{children}</div>}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────
export const AccountSettings: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();

  // ── Section open/close ────────────────────────────────────────────────────
  const [open, setOpen] = useState({
    basics: true, privacy: true, communication: true,
  });
  const toggle = (key: keyof typeof open) =>
    setOpen(prev => ({ ...prev, [key]: !prev[key] }));

  // ── UI state ──────────────────────────────────────────────────────────────
  const [isLoading, setIsLoading]               = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [showPlanModal, setShowPlanModal]             = useState(false);
  const [showPassword, setShowPassword]         = useState({ current: false, new: false, confirm: false });
  const [editingEmail, setEditingEmail]         = useState(false);
  const [editingPhone, setEditingPhone]         = useState(false);
  const [editingLocation, setEditingLocation]   = useState(false);
  const [passwordErrors, setPasswordErrors]     = useState<Record<string, string>>({});

  // ── Data state ────────────────────────────────────────────────────────────
  const [personalInfo, setPersonalInfo] = useState<PersonalInfo>({ firstName: '', lastName: '', email: '', phone: '' });
  const [careLocation,  setCareLocation] = useState<CareLocation>({ address: '', city: '', state: '', zip: '' });
  const [passwordData,  setPasswordData] = useState<PasswordData>({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [commPrefs,     setCommPrefs]    = useState<CommPrefs>({ newsletter: false, newMatches: true, caregiverReviews: true });
  const [privacyShowBookings, setPrivacyShowBookings] = useState(true);
  const [savedSearches, setSavedSearches]        = useState<SavedSearch[]>([]);
  const [identityStatus, setIdentityStatus]      = useState<'verified' | 'pending' | 'not_started'>('not_started');
  const [joinedDate, setJoinedDate]              = useState('');
  const [googleEmail, setGoogleEmail]            = useState<string | null>(null);
  const [zipLookingUp, setZipLookingUp]          = useState(false);

  // ── Zip → city/state autofill ─────────────────────────────────────────────
  const zipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lookupZip = useCallback((zip: string) => {
    if (zipTimerRef.current) clearTimeout(zipTimerRef.current);
    if (zip.length !== 5) return;
    zipTimerRef.current = setTimeout(async () => {
      setZipLookingUp(true);
      try {
        const res = await fetch(`https://api.zippopotam.us/us/${zip}`);
        if (!res.ok) return;
        const data = await res.json();
        const place = data.places?.[0];
        if (place) {
          setCareLocation(prev => ({
            ...prev,
            city:  prev.city  || place['place name'],
            state: prev.state || place['state abbreviation'],
          }));
        }
      } catch { /* non-critical */ }
      finally { setZipLookingUp(false); }
    }, 400);
  }, []);

  // ── Load on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    const currentUser = authService.getCurrentUser();
    if (!currentUser) { navigate('/login'); return; }

    // Firebase Auth data (name + email only — phone is stored in Firestore)
    const nameParts = (currentUser.displayName || '').split(' ');
    setPersonalInfo(prev => ({
      ...prev,
      firstName: nameParts[0] || '',
      lastName:  nameParts.slice(1).join(' ') || '',
      email:     currentUser.email || '',
    }));

    // Joined date
    if (currentUser.metadata?.creationTime) {
      setJoinedDate(new Date(currentUser.metadata.creationTime).toLocaleDateString('en-US', {
        month: '2-digit', day: '2-digit', year: 'numeric',
      }));
    }

    // Google provider
    const googleProv = currentUser.providerData?.find((p: any) => p.providerId === 'google.com');
    if (googleProv?.email) setGoogleEmail(googleProv.email);

    // Firestore — phone, address, and settings
    if (db) {
      db.collection('users').doc(currentUser.uid).get().then(doc => {
        if (!doc.exists) return;
        const d = doc.data() as any;

        // Phone saved by signup
        if (d.phone) setPersonalInfo(prev => ({ ...prev, phone: d.phone }));

        // Address — prefer flat fields saved by signup, fall back to old careLocation object
        const flat = d.street || d.zipCode || d.city || d.state;
        if (flat) {
          setCareLocation({
            address: d.street   || '',
            zip:     d.zipCode  || '',
            city:    d.city     || '',
            state:   d.state    || '',
          });
        } else if (d.careLocation) {
          setCareLocation(d.careLocation);
        }

        if (typeof d.privacyShowBookings === 'boolean') setPrivacyShowBookings(d.privacyShowBookings);
        if (Array.isArray(d.savedSearches)) setSavedSearches(d.savedSearches);
        if (d.identityCheckStatus) setIdentityStatus(d.identityCheckStatus);
        if (d.commPrefs) setCommPrefs({ newsletter: false, newMatches: true, caregiverReviews: true, ...d.commPrefs });
      }).catch(() => {});
    }
  }, [navigate]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const saving = async (fn: () => Promise<void>, successMsg: string) => {
    setIsLoading(true);
    try {
      await fn();
      addToast(successMsg, 'success');
    } catch {
      addToast('Something went wrong — please try again', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveBasics = () => saving(async () => {
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    await db.collection('users').doc(user.uid).update({
      displayName: `${personalInfo.firstName} ${personalInfo.lastName}`.trim(),
      phone: personalInfo.phone,
    });
  }, 'Account updated');

  const handleSaveEmail = () => saving(async () => {
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    await db.collection('users').doc(user.uid).update({ email: personalInfo.email });
    setEditingEmail(false);
  }, 'Email updated');

  const handleSavePhone = () => saving(async () => {
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    await db.collection('users').doc(user.uid).update({ phone: personalInfo.phone });
    setEditingPhone(false);
  }, 'Phone number updated');

  const handleSaveLocation = () => saving(async () => {
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    await db.collection('users').doc(user.uid).update({
      street:   careLocation.address,
      zipCode:  careLocation.zip,
      city:     careLocation.city,
      state:    careLocation.state,
      location: `${careLocation.city}, ${careLocation.state} ${careLocation.zip}`.trim(),
      careLocation, // keep legacy field in sync
    });
    setEditingLocation(false);
  }, 'Location saved');

  const handleSaveCommPrefs = () => saving(async () => {
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    await db.collection('users').doc(user.uid).update({ commPrefs });
  }, 'Communication preferences saved');

  const handleChangePassword = async () => {
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setPasswordErrors({ confirmPassword: 'Passwords do not match' });
      return;
    }
    await saving(async () => {
      await new Promise(r => setTimeout(r, 400));
      setIsPasswordModalOpen(false);
      setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
    }, 'Password changed');
  };

  const handleTogglePrivacy = async () => {
    const next = !privacyShowBookings;
    setPrivacyShowBookings(next);
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    await db.collection('users').doc(user.uid).update({ privacyShowBookings: next }).catch(() => {});
    addToast(next ? 'Booking visibility enabled' : 'Booking visibility hidden', 'success');
  };

  const handleDeleteSavedSearch = async (idx: number) => {
    const next = savedSearches.filter((_, i) => i !== idx);
    setSavedSearches(next);
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    db.collection('users').doc(user.uid).update({ savedSearches: next })
      .catch(() => setSavedSearches(savedSearches));
  };

  const handleFrequencyChange = async (idx: number, freq: 'daily' | 'weekly' | 'off') => {
    const next = savedSearches.map((s, i) => i === idx ? { ...s, emailFrequency: freq } : s);
    setSavedSearches(next);
    const user = authService.getCurrentUser();
    if (!user?.uid || !db) return;
    db.collection('users').doc(user.uid).update({ savedSearches: next }).catch(() => {});
  };

  // ── Toggle switch ─────────────────────────────────────────────────────────
  const Toggle = ({ on, onToggle }: { on: boolean; onToggle: () => void }) => (
    <button
      onClick={onToggle}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-primary-600' : 'bg-slate-300'}`}
    >
      <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  );

  // ── Checkbox ──────────────────────────────────────────────────────────────
  const Checkbox = ({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) => (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <div
        onClick={onChange}
        className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors cursor-pointer ${
          checked ? 'bg-primary-600 border-primary-600' : 'border-slate-300 bg-white'
        }`}
      >
        {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
      </div>
      <span className="text-sm text-slate-700">{label}</span>
    </label>
  );

  // ── Input field ───────────────────────────────────────────────────────────
  const inputCls = 'px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-400 w-full max-w-xs';

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientNavigation />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 pb-32">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Settings</h1>

        {/* ── Two-column layout ─────────────────────────────────────────── */}
        <div className="flex gap-6 items-start">

          {/* ── Left: sections ────────────────────────────────────────── */}
          <div className="flex-1 min-w-0">

            {/* ── 1. Account Basics ─────────────────────────────────── */}
            <Section title="Account Basics" open={open.basics} onToggle={() => toggle('basics')}>
              <div className="divide-y divide-slate-100">

                {/* Name */}
                <Row label="Name">
                  <p className="text-sm font-semibold text-slate-900">
                    {[personalInfo.firstName, personalInfo.lastName].filter(Boolean).join(' ') || '—'}
                  </p>
                  {joinedDate && <p className="text-xs text-slate-400 mt-0.5">Joined {joinedDate}</p>}
                </Row>

                {/* Membership */}
                <Row label="Membership plan">
                  <p className="text-sm text-slate-700">
                    None{' '}
                    <button onClick={() => setShowPlanModal(true)} className="text-primary-600 hover:underline font-medium">
                      Add a plan
                    </button>
                  </p>
                </Row>

                {/* Identity check */}
                <Row label="Identity check">
                  {identityStatus === 'verified' ? (
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-700">
                      <Check className="w-4 h-4" /> Identity Verified
                    </span>
                  ) : identityStatus === 'pending' ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-accent-600">
                      <Loader2 className="w-4 h-4 animate-spin" /> Verification in progress
                    </span>
                  ) : (
                    <button
                      onClick={async () => {
                        try {
                          const returnUrl = `${window.location.origin}/client/settings`;
                          await startIdentityVerification(returnUrl);
                        } catch (err: any) {
                          addToast(err?.message || 'Could not start identity verification', 'error');
                        }
                      }}
                      className="text-sm text-primary-600 hover:underline"
                    >
                      Complete an identity check
                    </button>
                  )}
                </Row>

                {/* Email */}
                <Row label="Email">
                  {editingEmail ? (
                    <div className="space-y-2 max-w-sm">
                      <input
                        type="email"
                        value={personalInfo.email}
                        onChange={e => setPersonalInfo({ ...personalInfo, email: e.target.value })}
                        className={inputCls}
                        autoFocus
                      />
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={handleSaveEmail}
                          disabled={isLoading}
                          className="px-3 py-1.5 bg-primary-600 text-white text-xs font-semibold rounded-lg hover:bg-primary-700 transition-colors"
                        >
                          {isLoading ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingEmail(false)}
                          className="px-3 py-1.5 border border-slate-200 text-slate-600 text-xs font-medium rounded-lg hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <p className="text-sm text-slate-700">{personalInfo.email || <span className="text-slate-400">Not set</span>}</p>
                      <button onClick={() => setEditingEmail(true)} className="text-xs text-primary-600 hover:underline mt-0.5">Edit</button>
                    </div>
                  )}
                </Row>

                {/* Password */}
                <Row label="Password">
                  <button
                    onClick={() => setIsPasswordModalOpen(true)}
                    className="text-sm text-primary-600 hover:underline font-medium"
                  >
                    Change Password
                  </button>
                </Row>

                {/* Mobile phone */}
                <Row label="Mobile phone">
                  {editingPhone ? (
                    <div className="space-y-2 max-w-sm">
                      <input
                        type="tel"
                        value={personalInfo.phone}
                        onChange={e => setPersonalInfo({ ...personalInfo, phone: e.target.value })}
                        placeholder="(555) 123-4567"
                        className={inputCls}
                        autoFocus
                      />
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={handleSavePhone}
                          disabled={isLoading}
                          className="px-3 py-1.5 bg-primary-600 text-white text-xs font-semibold rounded-lg hover:bg-primary-700 transition-colors"
                        >
                          {isLoading ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingPhone(false)}
                          className="px-3 py-1.5 border border-slate-200 text-slate-600 text-xs font-medium rounded-lg hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <p className="text-sm text-slate-700">{personalInfo.phone || <span className="text-slate-400">Not set</span>}</p>
                      <button onClick={() => setEditingPhone(true)} className="text-xs text-primary-600 hover:underline mt-0.5">Edit</button>
                    </div>
                  )}
                </Row>

                {/* Location */}
                <Row label="Location">
                  {editingLocation ? (
                    <div className="space-y-2 max-w-sm">
                      <input
                        type="text"
                        placeholder="Street address"
                        value={careLocation.address}
                        onChange={e => setCareLocation({ ...careLocation, address: e.target.value })}
                        className={inputCls}
                      />
                      <div className="relative">
                        <input
                          placeholder="ZIP code"
                          value={careLocation.zip}
                          maxLength={5}
                          onChange={e => {
                            const zip = e.target.value.replace(/\D/g, '').slice(0, 5);
                            setCareLocation(prev => ({ ...prev, zip, city: '', state: '' }));
                            lookupZip(zip);
                          }}
                          className={inputCls}
                        />
                        {zipLookingUp && (
                          <Loader2 className="w-4 h-4 text-slate-400 animate-spin absolute right-3 top-2.5" />
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          placeholder="City"
                          value={careLocation.city}
                          onChange={e => setCareLocation({ ...careLocation, city: e.target.value })}
                          className={inputCls}
                        />
                        <input
                          placeholder="State"
                          value={careLocation.state}
                          onChange={e => setCareLocation({ ...careLocation, state: e.target.value })}
                          className={inputCls}
                        />
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={handleSaveLocation}
                          disabled={isLoading}
                          className="px-3 py-1.5 bg-primary-600 text-white text-xs font-semibold rounded-lg hover:bg-primary-700 transition-colors"
                        >
                          {isLoading ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingLocation(false)}
                          className="px-3 py-1.5 border border-slate-200 text-slate-600 text-xs font-medium rounded-lg hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      {careLocation.address || careLocation.city ? (
                        <div className="text-sm text-slate-700 space-y-0.5">
                          {careLocation.address && <p>{careLocation.address}</p>}
                          <p>
                            {[careLocation.city, careLocation.state].filter(Boolean).join(', ')}
                            {careLocation.zip ? ` ${careLocation.zip}` : ''}
                          </p>
                        </div>
                      ) : (
                        <span className="text-sm text-slate-400">Not set</span>
                      )}
                      <button
                        onClick={() => setEditingLocation(true)}
                        className="text-xs text-primary-600 hover:underline mt-0.5"
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </Row>
              </div>

            </Section>

            {/* ── 2. Privacy Settings ───────────────────────────────── */}
            <Section title="Privacy Settings" open={open.privacy} onToggle={() => toggle('privacy')}>
              <p className="text-sm text-slate-500 mb-4">
                Allow other families to see a list of the caregivers you book on your profile.
              </p>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Show booked caregivers</span>
                <Toggle on={privacyShowBookings} onToggle={handleTogglePrivacy} />
              </div>
            </Section>

            {/* ── 3. Communication ─────────────────────────────────── */}
            <Section title="Communication" open={open.communication} onToggle={() => toggle('communication')}>
              <p className="text-sm text-slate-500 mb-4">
                Please note that independent of your selections below you will still receive emails related to any bookings, messages, or purchases you initiate on CareConnex.
              </p>

              {/* Checkboxes */}
              <div className="space-y-3 mb-6">
                <div className="flex items-start justify-between gap-4">
                  <span className={`${LABEL_W} text-sm text-slate-500 pt-0.5`}>Newsletter</span>
                  <div className="flex-1">
                    <Checkbox
                      checked={commPrefs.newsletter}
                      onChange={() => setCommPrefs(p => ({ ...p, newsletter: !p.newsletter }))}
                      label="Send me a weekly CareConnex newsletter"
                    />
                  </div>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <span className={`${LABEL_W} text-sm text-slate-500 pt-0.5`}>New Matches</span>
                  <div className="flex-1">
                    <Checkbox
                      checked={commPrefs.newMatches}
                      onChange={() => setCommPrefs(p => ({ ...p, newMatches: !p.newMatches }))}
                      label="Email me when caregivers matching my criteria become available"
                    />
                  </div>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <span className={`${LABEL_W} text-sm text-slate-500 pt-0.5`}>Caregiver Reviews</span>
                  <div className="flex-1">
                    <Checkbox
                      checked={commPrefs.caregiverReviews}
                      onChange={() => setCommPrefs(p => ({ ...p, caregiverReviews: !p.caregiverReviews }))}
                      label="Email me when caregivers I've booked receive new reviews"
                    />
                  </div>
                </div>
              </div>

              {/* Save comm prefs */}
              <button
                onClick={handleSaveCommPrefs}
                disabled={isLoading}
                className="mb-6 px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-50"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Save Preferences'}
              </button>

              {/* Saved Searches */}
              <div className="border-t border-slate-100 pt-5">
                <div className="flex items-start gap-4">
                  <span className={`${LABEL_W} text-sm text-slate-500 pt-1`}>Saved Searches</span>
                  <div className="flex-1 min-w-0">
                    {savedSearches.length === 0 ? (
                      <div className="py-4 text-center">
                        <p className="text-sm text-slate-400">No saved searches yet.</p>
                        <p className="text-xs text-slate-400 mt-1">
                          Use "Save Search" in Browse Caregivers to save your filters here.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {savedSearches.map((s, i) => (
                          <div key={i} className="border border-slate-200 rounded-xl p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-primary-700 text-sm">{s.name}</p>
                                <p className="text-xs text-slate-400 mt-0.5">
                                  Saved {new Date(s.savedAt).toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })}
                                </p>
                                {s.filters && Object.keys(s.filters).length > 0 && (
                                  <p className="text-xs text-slate-500 mt-1.5">
                                    <span className="font-medium">{Object.keys(s.filters).length} Filters:</span>{' '}
                                    {[
                                      s.filters.searchTerm,
                                      s.filters.availability,
                                      s.filters.location,
                                      s.filters.distance ? `${s.filters.distance} miles` : null,
                                      ...(s.filters.certifications || []),
                                    ].filter(Boolean).join(', ')}
                                  </p>
                                )}
                              </div>
                              <button
                                onClick={() => handleDeleteSavedSearch(i)}
                                className="text-slate-400 hover:text-red-500 transition-colors flex-shrink-0"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                            <div className="flex items-center gap-2 mt-3">
                              <span className="text-xs text-slate-500">Email notifications:</span>
                              <select
                                value={s.emailFrequency}
                                onChange={e => handleFrequencyChange(i, e.target.value as 'daily' | 'weekly' | 'off')}
                                className="text-xs border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary-300"
                              >
                                <option value="daily">Daily</option>
                                <option value="weekly">Weekly</option>
                                <option value="off">Off</option>
                              </select>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Section>

          </div>

          {/* ── Right sidebar ─────────────────────────────────────────── */}
          <div className="w-64 flex-shrink-0 hidden lg:block sticky top-8 space-y-4">
            {/* Upgrade card */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <p className="font-semibold text-slate-900 text-sm mb-1">Hiring a new caregiver?</p>
              <p className="text-xs text-slate-500 mb-3">Get a plan:</p>
              <ul className="text-sm text-slate-700 space-y-1 mb-4">
                <li className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-primary-500 rounded-full" />
                  Monthly · <span className="font-semibold">$29.95</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-primary-500 rounded-full" />
                  Quarterly · <span className="font-semibold">$49.95</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-primary-500 rounded-full" />
                  Annual · <span className="font-semibold">$89.95</span>
                </li>
              </ul>
              <button
                onClick={() => setShowPlanModal(true)}
                className="w-full py-2 bg-primary-600 text-white text-sm font-semibold rounded-xl hover:bg-primary-700 transition-colors"
              >
                Upgrade
              </button>
            </div>

            {/* Quick links */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Quick Links</p>
              <div className="space-y-2 text-sm">
                <button onClick={() => navigate('/client/membership')} className="block text-primary-600 hover:underline">Membership Plans</button>
                <button onClick={() => navigate('/client/payments')} className="block text-primary-600 hover:underline">Payment History</button>
                <button onClick={() => navigate('/client/find-caregivers')} className="block text-primary-600 hover:underline">Find Caregivers</button>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ── Password Modal ────────────────────────────────────────────────── */}
      {isPasswordModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-900">Change Password</h2>
              <button onClick={() => setIsPasswordModalOpen(false)} className="p-1.5 hover:bg-slate-100 rounded-lg">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {[
                { key: 'currentPassword', label: 'Current Password', showKey: 'current' },
                { key: 'newPassword',     label: 'New Password',     showKey: 'new' },
                { key: 'confirmPassword', label: 'Confirm Password', showKey: 'confirm' },
              ].map(({ key, label, showKey }) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}</label>
                  <div className="relative">
                    <input
                      type={showPassword[showKey as keyof typeof showPassword] ? 'text' : 'password'}
                      value={passwordData[key as keyof PasswordData]}
                      onChange={e => setPasswordData({ ...passwordData, [key]: e.target.value })}
                      className="w-full px-3 py-2.5 pr-10 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                      placeholder={label}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(prev => ({ ...prev, [showKey]: !prev[showKey as keyof typeof showPassword] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                    >
                      {showPassword[showKey as keyof typeof showPassword]
                        ? <EyeOff className="w-4 h-4 text-slate-400" />
                        : <Eye className="w-4 h-4 text-slate-400" />}
                    </button>
                  </div>
                  {passwordErrors[key] && (
                    <p className="text-xs text-red-500 mt-1">{passwordErrors[key]}</p>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-3 px-6 pb-6">
              <button
                onClick={() => setIsPasswordModalOpen(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={handleChangePassword}
                disabled={isLoading}
                className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Change Password'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPlanModal && (
        <PlanSelectModal onClose={() => setShowPlanModal(false)} />
      )}
    </div>
  );
};
