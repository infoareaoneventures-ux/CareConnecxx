import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronUp, ChevronDown, Check, X, Eye, EyeOff, Loader2, Trash2,
} from 'lucide-react';
import { ClientNavigation } from './ClientNavigation';
import { PlanSelectModal } from './PlanSelectModal';
import { authService } from '../../services/api';
import { startIdentityVerification } from '../../services/stripeService';
import firebase, { auth, db, storage } from '../../lib/firebase';
import { useCareConnex } from '../../context/CareConnexContext';

// ── Types ───────────────────────────────────────────────────────────────────
interface PersonalInfo  { firstName: string; lastName: string; email: string; phone: string; }
interface CareLocation  { address: string; city: string; state: string; zip: string; }
interface PasswordData  { currentPassword: string; newPassword: string; confirmPassword: string; }

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
  const { addToast, blockedIds, blockedUserProfiles, unblockUser } = useCareConnex();
  const blockedProfiles = [
    ...Object.entries(blockedUserProfiles).map(([id, p]) => ({ id, ...p })),
    ...Array.from(blockedIds).filter(id => !blockedUserProfiles[id]).map(id => ({ id, name: 'Blocked User', photo: '' })),
  ];

  // ── Section open/close ────────────────────────────────────────────────────
  const [open, setOpen] = useState({
    basics: true, blocked: false,
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
  const [identityStatus, setIdentityStatus]      = useState<'verified' | 'pending' | 'not_started'>('not_started');
  const [joinedDate, setJoinedDate]              = useState('');
  const [googleEmail, setGoogleEmail]            = useState<string | null>(null);
  const [zipLookingUp, setZipLookingUp]          = useState(false);
  const [photoURL, setPhotoURL]                  = useState<string | null>(null);
  const [photoUploading, setPhotoUploading]      = useState(false);
  const photoInputRef                            = useRef<HTMLInputElement>(null);

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

        // Name fallback: Auth displayName is unset for phone-OTP signups — the
        // SMS onboarding stores the name on the users doc instead (clients:
        // firstName; saved edits: displayName). Without this the Name row
        // rendered "—" for every SMS-onboarded client.
        if (!currentUser.displayName) {
          const docName: string = d.displayName || d.firstName || d.name || '';
          if (docName) {
            const parts = docName.split(' ');
            setPersonalInfo(prev => ({
              ...prev,
              firstName: prev.firstName || parts[0] || '',
              lastName:  prev.lastName  || parts.slice(1).join(' ') || '',
            }));
          }
        }

        // Phone saved by signup
        if (d.phone) setPersonalInfo(prev => ({ ...prev, phone: d.phone }));
        if (d.photoURL || d.photo || d.profilePhoto) setPhotoURL(d.photoURL || d.photo || d.profilePhoto);

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

        if (d.identityCheckStatus) setIdentityStatus(d.identityCheckStatus);
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

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !storage) return;
    const user = authService.getCurrentUser();
    if (!user?.uid) return;
    setPhotoUploading(true);
    try {
      const ref = storage.ref(`profile_photos/${user.uid}/profile`);
      await ref.put(file);
      const url = await ref.getDownloadURL();
      // Write to all three sources so every component that reads photo finds it
      await Promise.all([
        db!.collection('users').doc(user.uid).update({ photoURL: url }),
        db!.collection('senior_profiles').doc(user.uid).set({ imageUrl: url }, { merge: true }),
        (user as any).updateProfile?.({ photoURL: url }).catch(() => {}),
      ]);
      setPhotoURL(url);
      addToast('Profile photo updated', 'success');
    } catch {
      addToast('Failed to upload photo', 'error');
    } finally {
      setPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  };

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

  // ── Delete account state ──────────────────────────────────────────────────
  const [showDeleteModal, setShowDeleteModal]   = useState(false);
  const [deletePassword, setDeletePassword]     = useState('');
  const [showDeletePassword, setShowDeletePassword] = useState(false);
  const [deleteError, setDeleteError]           = useState('');
  const [deletingAccount, setDeletingAccount]   = useState(false);

  const handleDeleteAccount = async () => {
    if (!deletePassword) { setDeleteError('Please enter your password.'); return; }
    setDeletingAccount(true);
    setDeleteError('');
    try {
      const user = firebase.auth().currentUser;
      if (!user?.email) throw new Error('no-user');
      const credential = firebase.auth.EmailAuthProvider.credential(user.email, deletePassword);
      await user.reauthenticateWithCredential(credential);
      await authService.deleteUserAccount();
    } catch (err: any) {
      setDeletingAccount(false);
      setDeleteError(
        err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential'
          ? 'Incorrect password. Please try again.'
          : 'Failed to delete account. Please try again.',
      );
    }
  };

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

                {/* Profile photo */}
                <Row label="Profile photo">
                  <div className="flex items-center gap-4">
                    {photoURL ? (
                      <div className="w-16 h-16 rounded-full overflow-hidden border border-slate-200 flex-shrink-0">
                        <img src={photoURL} alt="Profile" className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="w-16 h-16 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-primary-700 font-bold text-xl">
                          {personalInfo.firstName?.charAt(0).toUpperCase() || '?'}
                        </span>
                      </div>
                    )}
                    <div>
                      <button
                        onClick={() => photoInputRef.current?.click()}
                        disabled={photoUploading}
                        className="text-sm text-primary-600 font-medium hover:text-primary-700 disabled:opacity-50"
                      >
                        {photoUploading ? 'Uploading...' : photoURL ? 'Change photo' : 'Upload photo'}
                      </button>
                      <p className="text-xs text-slate-400 mt-0.5">JPG or PNG, max 5 MB</p>
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={handlePhotoUpload}
                      />
                    </div>
                  </div>
                </Row>

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

            {/* ── 2. Blocked Users ──────────────────────────────────── */}
            <Section title="Blocked Users" open={open.blocked} onToggle={() => toggle('blocked')}>
              {blockedProfiles.length === 0 ? (
                <p className="text-sm text-slate-500">You haven't blocked anyone.</p>
              ) : (
                <div className="space-y-3">
                  {blockedProfiles.map(p => (
                    <div key={p.id} className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-0">
                      <div className="flex items-center gap-3">
                        {p.photo ? (
                          <img src={p.photo} alt={p.name} className="w-9 h-9 rounded-full object-cover" />
                        ) : (
                          <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 text-sm font-semibold">
                            {p.name.charAt(0)}
                          </div>
                        )}
                        <span className="text-sm font-medium text-slate-800">{p.name}</span>
                      </div>
                      <button
                        onClick={() => unblockUser(p.id)
                          .then(() => addToast(`${p.name} unblocked.`, 'success'))
                          .catch(() => addToast(`Couldn't unblock ${p.name}. Please try again.`, 'error'))}
                        className="text-xs text-primary-600 hover:text-primary-700 font-medium border border-primary-200 hover:border-primary-400 px-3 py-1 rounded-lg transition-colors"
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* ── 3. Delete Account ──────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden mb-4 px-6 py-5">
              <p className="text-sm text-slate-500 mb-4">Deleting your account is permanent and cannot be undone.</p>
              <button
                onClick={() => { setDeletePassword(''); setDeleteError(''); setShowDeleteModal(true); }}
                className="flex items-center gap-2 text-red-500 hover:text-red-700 font-medium text-sm transition-colors"
              >
                <Trash2 className="w-4 h-4" /> Delete account
              </button>
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

      {/* ── Delete Account Modal ──────────────────────────────────────────── */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">Delete account</h2>
              <button onClick={() => setShowDeleteModal(false)} className="p-1.5 hover:bg-slate-100 rounded-lg">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-slate-600">Enter your password to confirm. This action is permanent and cannot be undone.</p>
              <div className="relative">
                <input
                  type={showDeletePassword ? 'text' : 'password'}
                  value={deletePassword}
                  onChange={e => { setDeletePassword(e.target.value); setDeleteError(''); }}
                  placeholder="Current password"
                  className="w-full px-3 py-2.5 pr-10 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-400"
                />
                <button type="button" onClick={() => setShowDeletePassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showDeletePassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {deleteError && <p className="text-xs text-red-500">{deleteError}</p>}
              <button
                onClick={handleDeleteAccount}
                disabled={deletingAccount || !deletePassword}
                className="w-full py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {deletingAccount ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                {deletingAccount ? 'Deleting...' : 'Delete my account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
