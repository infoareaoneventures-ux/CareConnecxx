import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronUp, ChevronDown, Check, X, Loader2, Trash2,
} from 'lucide-react';
import { ClientNavigation } from './ClientNavigation';
import { PlanSelectModal } from './PlanSelectModal';
import { authService } from '../../services/api';
import { startIdentityVerification, listenToSubscriptionStatus, hasActiveMembership, SubscriptionStatus } from '../../services/stripeService';
import { auth, db, storage } from '../../lib/firebase';
import { useCareConnex } from '../../context/CareConnexContext';
import { usePhoneReauth } from '../../hooks/usePhoneReauth';
import { submitAccountAction } from '../../services/accountActionQueue';

// Only a real link renders as an avatar — a stray word saved in the photo field (a prod
// account had photoURL === 'skipped') must fall back to the initials, not a broken <img>.
const isPhotoUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//i.test(v);

const DELETE_RECAPTCHA_CONTAINER = 'account-settings-delete-recaptcha';

// ── Types ───────────────────────────────────────────────────────────────────
interface PersonalInfo  { firstName: string; lastName: string; email: string; phone: string; }
interface CareLocation  { address: string; city: string; state: string; zip: string; }

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
  const [showPlanModal, setShowPlanModal]             = useState(false);
  const [editingEmail, setEditingEmail]         = useState(false);
  const [editingPhone, setEditingPhone]         = useState(false);
  const [editingLocation, setEditingLocation]   = useState(false);

  // ── Data state ────────────────────────────────────────────────────────────
  const [personalInfo, setPersonalInfo] = useState<PersonalInfo>({ firstName: '', lastName: '', email: '', phone: '' });
  const [careLocation,  setCareLocation] = useState<CareLocation>({ address: '', city: '', state: '', zip: '' });
  const [identityStatus, setIdentityStatus]      = useState<'verified' | 'pending' | 'not_started'>('not_started');
  const [joinedDate, setJoinedDate]              = useState('');
  const [googleEmail, setGoogleEmail]            = useState<string | null>(null);
  const [zipLookingUp, setZipLookingUp]          = useState(false);
  const [photoURL, setPhotoURL]                  = useState<string | null>(null);
  const [photoUploading, setPhotoUploading]      = useState(false);
  const [subscription, setSubscription]          = useState<SubscriptionStatus | null>(null);
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
        // Recovery email: phone-OTP accounts have no Auth email — the address lives on
        // the users doc (that is where a confirmed email change is written). Without
        // this the row said "Not set" and the phone edit was blocked (live-caught 2026-09-19).
        if (d.email) setPersonalInfo(prev => ({ ...prev, email: prev.email || d.email }));
        // Confirmed only for the exact address on file (accountRecovery.ts isEmailVerified).
        setEmailVerified(d.emailVerified === true && !!d.email && String(d.emailVerifiedFor || '').toLowerCase() === String(d.email || '').toLowerCase());
        { const savedPhoto = [d.photoURL, d.photo, d.profilePhoto].find(isPhotoUrl); if (savedPhoto) setPhotoURL(savedPhoto); }

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

    // Membership status — mirrors Membership.tsx's own listener exactly
    // (same collection, same shape) so this row can never drift from what
    // that page shows. Real subscription state, not the "None" placeholder
    // this row used to be hardcoded to regardless of billing status.
    const unsubscribe = listenToSubscriptionStatus(currentUser.uid, setSubscription);
    return () => unsubscribe();
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

  // Email and phone changes both go through a verification link now, rather
  // than writing straight to Firestore — an unverified swap of either would
  // let anyone with brief access to this page quietly take over the account's
  // recovery channel (email) or its login (phone). See the phone-recovery
  // design: the same email round-trip gates a change made here, logged in,
  // as it does someone locked out entirely.
  const [emailRequestSent, setEmailRequestSent] = useState(false);
  const [phoneRequestSent, setPhoneRequestSent] = useState(false);
  const [newEmailDraft, setNewEmailDraft] = useState('');
  // Recovery email is confirmed at first entry and a change is approved from the
  // confirmed address first (2026-09-20): stage awaiting_old_approval → the old
  // inbox (or a code texted to the phone) approves; awaiting_new_confirm → the
  // new inbox's link does the swap.
  const [emailVerified, setEmailVerified] = useState(false);
  const [emailChange, setEmailChange] = useState<{ stage: 'awaiting_old_approval' | 'awaiting_new_confirm'; token: string; sentTo: string } | null>(null);
  const [fallbackCodeSent, setFallbackCodeSent] = useState(false);
  const [fallbackCode, setFallbackCode] = useState('');

  const handleRequestEmailChange = () => saving(async () => {
    const user = authService.getCurrentUser();
    if (!newEmailDraft.trim() || !user?.uid) return;
    const r = await submitAccountAction<{ stage: 'awaiting_old_approval' | 'awaiting_new_confirm'; token: string; sentTo: string }>('request_email_change', { uid: user.uid, newEmail: newEmailDraft.trim() });
    setEmailChange(r);
    setFallbackCodeSent(false);
    setFallbackCode('');
    setEmailRequestSent(true);
  }, 'Link sent');

  const handleResendEmailConfirmation = () => saving(async () => {
    const user = authService.getCurrentUser();
    if (!user?.uid) return;
    await submitAccountAction('resend_email_confirmation', { uid: user.uid });
  }, 'Confirmation link sent — check your inbox (and Junk)');

  const handleStartFallback = () => saving(async () => {
    if (!emailChange?.token) return;
    await submitAccountAction('start_email_change_fallback', { token: emailChange.token });
    setFallbackCodeSent(true);
  }, 'Code texted to your phone');

  const handleConfirmFallback = () => saving(async () => {
    if (!emailChange?.token || !fallbackCode.trim()) return;
    const r = await submitAccountAction<{ sentTo: string }>('confirm_email_change_fallback', { token: emailChange.token, code: fallbackCode.trim() });
    setEmailChange({ stage: 'awaiting_new_confirm', token: emailChange.token, sentTo: r.sentTo });
  }, 'Approved — confirmation link sent to the new address');

  const handleRequestPhoneChange = () => saving(async () => {
    await submitAccountAction('request_phone_change', { email: personalInfo.email });
    setPhoneRequestSent(true);
  }, 'Verification link sent');

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

  // ── Delete account state ──────────────────────────────────────────────────
  // Reauth is via phone OTP, not a password — no account here has a password
  // credential (login is phone-OTP only), so proving identity means proving
  // control of the phone on file, the same way logging in does.
  const [showDeleteModal, setShowDeleteModal]   = useState(false);
  const [deleteStep, setDeleteStep]             = useState<'confirm' | 'otp'>('confirm');
  const [deleteCode, setDeleteCode]             = useState('');
  const [deletingAccount, setDeletingAccount]   = useState(false);
  const deleteReauth = usePhoneReauth(DELETE_RECAPTCHA_CONTAINER);

  const handleSendDeleteCode = async () => {
    const ok = await deleteReauth.sendCode();
    if (ok) setDeleteStep('otp');
  };

  const handleDeleteAccount = async () => {
    if (!deleteCode) { deleteReauth.setError('Enter the code we texted you.'); return; }
    setDeletingAccount(true);
    const confirmed = await deleteReauth.confirmCode(deleteCode);
    if (!confirmed) { setDeletingAccount(false); return; }
    try {
      await authService.deleteUserAccount();
    } catch {
      deleteReauth.setError('Failed to delete account. Please try again.');
      setDeletingAccount(false);
    }
  };

  const closeDeleteModal = () => {
    setShowDeleteModal(false);
    setDeleteStep('confirm');
    setDeleteCode('');
    deleteReauth.reset();
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
                          {personalInfo.firstName?.charAt(0)?.toUpperCase() || '?'}
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

                {/* Membership — mirrors Membership.tsx's own status logic exactly */}
                <Row label="Membership plan">
                  {subscription && hasActiveMembership(subscription) ? (
                    <p className="text-sm text-slate-700">
                      <span className="font-semibold text-slate-900">Standard Plan</span>{' '}
                      <span className="text-slate-400">
                        · {subscription.cancelAtPeriodEnd ? 'ends' : 'renews'}{' '}
                        {subscription.currentPeriodEnd?.toLocaleDateString() ?? '—'}
                      </span>{' '}
                      <button onClick={() => navigate('/client/membership')} className="text-primary-600 hover:underline font-medium">
                        Manage
                      </button>
                    </p>
                  ) : (
                    <p className="text-sm text-slate-700">
                      None{' '}
                      <button onClick={() => setShowPlanModal(true)} className="text-primary-600 hover:underline font-medium">
                        Add a plan
                      </button>
                    </p>
                  )}
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
                          const returnUrl = `${window.location.origin}/client/account`;
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

                {/* Email — used as the recovery channel for phone-number changes,
                    so a new value isn't live until its own confirmation link is
                    clicked (never a plain overwrite). */}
                <Row label="Recovery email">
                  {editingEmail ? (
                    emailRequestSent ? (
                      emailChange?.stage === 'awaiting_old_approval' ? (
                        <div className="text-sm text-slate-600 space-y-2 max-w-sm">
                          <p>
                            We emailed <span className="font-medium text-slate-800">{emailChange.sentTo}</span> to approve this change.
                            Once approved, <span className="font-medium text-slate-800">{newEmailDraft}</span> gets its own confirmation link. Nothing changes until then.
                          </p>
                          {fallbackCodeSent ? (
                            <div className="flex gap-2 items-center">
                              <input
                                value={fallbackCode}
                                onChange={e => setFallbackCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                inputMode="numeric"
                                placeholder="6-digit code"
                                className={inputCls}
                              />
                              <button
                                onClick={handleConfirmFallback}
                                disabled={isLoading || fallbackCode.trim().length < 4}
                                className="px-3 py-1.5 bg-primary-600 text-white text-xs font-semibold rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 shrink-0"
                              >
                                Confirm code
                              </button>
                            </div>
                          ) : (
                            <button onClick={handleStartFallback} disabled={isLoading} className="text-xs text-primary-600 hover:underline">
                              Can't open that inbox? Text me a code
                            </button>
                          )}
                          <button
                            onClick={() => { setEditingEmail(false); setEmailRequestSent(false); }}
                            className="block text-xs text-slate-500 hover:underline"
                          >
                            Done
                          </button>
                        </div>
                      ) : (
                      <p className="text-sm text-slate-600">
                        Check <span className="font-medium text-slate-800">{emailChange?.sentTo || newEmailDraft}</span> for a confirmation link. Your recovery email changes the moment it's opened.
                        <button
                          onClick={() => { setEditingEmail(false); setEmailRequestSent(false); }}
                          className="block text-xs text-primary-600 hover:underline mt-1"
                        >
                          Done
                        </button>
                      </p>
                      )
                    ) : (
                      <div className="space-y-2 max-w-sm">
                        <input
                          type="email"
                          value={newEmailDraft}
                          onChange={e => setNewEmailDraft(e.target.value)}
                          placeholder="you@example.com"
                          className={inputCls}
                          autoFocus
                        />
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={handleRequestEmailChange}
                            disabled={isLoading || !newEmailDraft.trim()}
                            className="px-3 py-1.5 bg-primary-600 text-white text-xs font-semibold rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
                          >
                            {isLoading ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Send confirmation link'}
                          </button>
                          <button
                            onClick={() => setEditingEmail(false)}
                            className="px-3 py-1.5 border border-slate-200 text-slate-600 text-xs font-medium rounded-lg hover:bg-slate-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                    <div>
                      <p className="text-sm text-slate-700">
                        {personalInfo.email || <span className="text-slate-400">Not set</span>}
                        {personalInfo.email && (
                          emailVerified
                            ? <span className="ml-2 text-[11px] font-semibold text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">Confirmed</span>
                            : <span className="ml-2 text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Not confirmed yet</span>
                        )}
                      </p>
                      <div className="flex gap-3 mt-0.5">
                        <button
                          onClick={() => { setNewEmailDraft(personalInfo.email); setEmailRequestSent(false); setEmailChange(null); setEditingEmail(true); }}
                          className="text-xs text-primary-600 hover:underline"
                        >
                          Edit
                        </button>
                        {personalInfo.email && !emailVerified && (
                          <button onClick={handleResendEmailConfirmation} disabled={isLoading} className="text-xs text-primary-600 hover:underline">
                            Resend confirmation link
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </Row>

                {/* Mobile phone — this is the login credential, so changing it
                    always goes through the recovery-email link, even while
                    signed in; the new number itself is entered on that page. */}
                <Row label="Mobile phone">
                  {editingPhone ? (
                    phoneRequestSent ? (
                      <p className="text-sm text-slate-600">
                        Check {personalInfo.email || 'your email'} for a link to finish changing your number.
                        <button
                          onClick={() => { setEditingPhone(false); setPhoneRequestSent(false); }}
                          className="block text-xs text-primary-600 hover:underline mt-1"
                        >
                          Done
                        </button>
                      </p>
                    ) : !personalInfo.email ? (
                      <p className="text-sm text-slate-600">
                        Set a recovery email above first — we use it to verify phone number changes.
                        <button onClick={() => setEditingPhone(false)} className="block text-xs text-primary-600 hover:underline mt-1">Close</button>
                      </p>
                    ) : !emailVerified ? (
                      <p className="text-sm text-slate-600">
                        Confirm your recovery email first — we use it to verify phone number changes.
                        <button onClick={handleResendEmailConfirmation} disabled={isLoading} className="block text-xs text-primary-600 hover:underline mt-1">Resend confirmation link</button>
                        <button onClick={() => setEditingPhone(false)} className="block text-xs text-slate-500 hover:underline mt-1">Close</button>
                      </p>
                    ) : (
                      <div className="space-y-2 max-w-sm">
                        <p className="text-sm text-slate-600">
                          We'll email a secure link to {personalInfo.email} to change your phone number.
                        </p>
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={handleRequestPhoneChange}
                            disabled={isLoading}
                            className="px-3 py-1.5 bg-primary-600 text-white text-xs font-semibold rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
                          >
                            {isLoading ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Send link'}
                          </button>
                          <button
                            onClick={() => setEditingPhone(false)}
                            className="px-3 py-1.5 border border-slate-200 text-slate-600 text-xs font-medium rounded-lg hover:bg-slate-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                    <div>
                      <p className="text-sm text-slate-700">{personalInfo.phone || <span className="text-slate-400">Not set</span>}</p>
                      <button
                        onClick={() => { setPhoneRequestSent(false); setEditingPhone(true); }}
                        className="text-xs text-primary-600 hover:underline mt-0.5"
                      >
                        Edit
                      </button>
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
                onClick={() => setShowDeleteModal(true)}
                className="flex items-center gap-2 text-red-500 hover:text-red-700 font-medium text-sm transition-colors"
              >
                <Trash2 className="w-4 h-4" /> Delete account
              </button>
            </div>
            {/* RecaptchaVerifier needs a stable DOM target; created per send. */}
            <div id={DELETE_RECAPTCHA_CONTAINER} />

          </div>

        </div>
      </main>

      {showPlanModal && (
        <PlanSelectModal onClose={() => setShowPlanModal(false)} />
      )}

      {/* ── Delete Account Modal ──────────────────────────────────────────── */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">Delete account</h2>
              <button onClick={closeDeleteModal} className="p-1.5 hover:bg-slate-100 rounded-lg">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-slate-600">This action is permanent and cannot be undone.</p>

              {deleteStep === 'confirm' ? (
                <>
                  <p className="text-sm text-slate-600">
                    We'll text a verification code to {personalInfo.phone || 'your phone'} to confirm it's you.
                  </p>
                  {deleteReauth.error && <p className="text-xs text-red-500">{deleteReauth.error}</p>}
                  <button
                    onClick={handleSendDeleteCode}
                    disabled={deleteReauth.sending}
                    className="w-full py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    {deleteReauth.sending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {deleteReauth.sending ? 'Sending code...' : 'Send verification code'}
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={deleteCode}
                    onChange={e => deleteCode !== e.target.value && setDeleteCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="6-digit code"
                    autoFocus
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-400"
                  />
                  {deleteReauth.error && <p className="text-xs text-red-500">{deleteReauth.error}</p>}
                  <button
                    onClick={handleDeleteAccount}
                    disabled={deletingAccount || deleteReauth.confirming || !deleteCode}
                    className="w-full py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    {(deletingAccount || deleteReauth.confirming) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    {(deletingAccount || deleteReauth.confirming) ? 'Deleting...' : 'Confirm & delete my account'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
