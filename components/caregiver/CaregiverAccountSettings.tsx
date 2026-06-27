import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Trash2, Pencil, CheckCircle, Loader2, AlertCircle, Clock, Eye, EyeOff, X } from 'lucide-react';
import { authService, dbService } from '../../services/api';
import firebase from '../../lib/firebase';
import { documentUploadService, DocumentType } from '../../services/documentUpload';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import type { Caregiver, CaregiverDocument, UserProfile } from '../../types';
import { geocodeToLatLng } from '../../utils/geocode';

const TRANSPORT_DOCS: { type: DocumentType; label: string; desc: string }[] = [
  { type: 'driversLicense', label: "Driver's License", desc: "Front of your valid driver's license" },
  { type: 'insurance', label: 'Vehicle Insurance', desc: 'Current auto insurance showing active coverage' },
  { type: 'registration', label: 'Vehicle Registration', desc: 'Current vehicle registration document' },
];


const GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];

function formatDob(raw: string): string {
  if (!raw) return '—';
  const parts = raw.split('-');
  if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`;
  return raw;
}

export const CaregiverAccountSettings: React.FC = () => {
  const { currentUser, addToast, blockedIds, blockedUserProfiles, unblockUser } = useCareConnex();
  const blockedProfiles = [
    ...Object.entries(blockedUserProfiles).map(([id, p]) => ({ id, ...p })),
    ...Array.from(blockedIds).filter(id => !blockedUserProfiles[id]).map(id => ({ id, name: 'Blocked User', photo: '' })),
  ];
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [prefs, setPrefs] = useState<Partial<UserProfile>>({});
  const [openAccount, setOpenAccount] = useState(true);
  const [openTransport, setOpenTransport] = useState(false);
  const [openBlocked, setOpenBlocked] = useState(false);

  // Personal info fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState('');
  const [phone, setPhone] = useState('');
  const [street, setStreet] = useState('');
  const [zip, setZip] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');

  // Edit mode toggles
  const [editingGender, setEditingGender] = useState(false);
  const [editingPhone, setEditingPhone] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);

  // Delete account modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [showDeletePassword, setShowDeletePassword] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);

  // Saving states
  const [savingGender, setSavingGender] = useState(false);
  const [savingPhone, setSavingPhone] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [zipLookingUp, setZipLookingUp] = useState(false);

  // Transport doc upload status
  const [transportStatus, setTransportStatus] = useState<Record<string, 'idle' | 'uploading' | 'done' | 'approved' | 'expired' | 'rejected' | 'error'>>({
    driversLicense: 'idle', insurance: 'idle', registration: 'idle',
  });
  const [transportExpiry, setTransportExpiry] = useState<Record<string, string | null>>({
    driversLicense: null, insurance: null, registration: null,
  });
  const transportRefs: Record<string, React.RefObject<HTMLInputElement>> = {
    driversLicense: useRef<HTMLInputElement>(null),
    insurance: useRef<HTMLInputElement>(null),
    registration: useRef<HTMLInputElement>(null),
  };

  // Password
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!currentUser?.uid) return;
      const p = await dbService.getUser(currentUser.uid);
      if (active && p) {
        const cp = p as any;
        setProfile(p as any);
        setFirstName(cp.firstName || cp.name?.split(' ')[0] || '');
        setLastName(cp.lastName || cp.name?.split(' ').slice(1).join(' ') || '');
        setDob(cp.dateOfBirth || cp.dob || '');
        setGender(cp.gender || '');
        setPhone(cp.phone || '');
        setStreet(cp.street || cp.streetAddress || cp.address || '');
        setZip(cp.zipCode || cp.zip || '');
        setCity(cp.city || '');
        setState(cp.state || '');
        setPrefs({});
        const docs = cp.documents || {};
        const resolveDocStatus = (doc: any) => {
          if (!doc?.url) return 'idle';
          if (doc.status === 'approved') {
            if (doc.expirationDate) {
              const [y,m,d] = doc.expirationDate.split('-');
              const today = new Date(); today.setHours(0,0,0,0);
              if (new Date(+y, +m-1, +d) < today) return 'expired';
            }
            return 'approved';
          }
          if (doc.status === 'rejected') return 'rejected';
          return 'done'; // uploaded, pending review
        };
        const newStatus: Record<string, 'idle' | 'uploading' | 'done' | 'approved' | 'expired' | 'rejected' | 'error'> = {
          driversLicense: resolveDocStatus(docs.driversLicense),
          insurance: resolveDocStatus(docs.insurance),
          registration: resolveDocStatus(docs.registration),
        };
        setTransportStatus(newStatus);
        const allApproved = Object.values(newStatus).every(s => s === 'approved');
        setOpenTransport(!allApproved);
        setTransportExpiry({
          driversLicense: docs.driversLicense?.expirationDate || null,
          insurance: docs.insurance?.expirationDate || null,
          registration: docs.registration?.expirationDate || null,
        });
      }
    })();
    return () => { active = false; };
  }, [currentUser?.uid]);

  const saveGender = async () => {
    if (!currentUser?.uid) return;
    setSavingGender(true);
    try {
      await dbService.updateUser('caregivers', currentUser.uid, { gender } as any);
      setEditingGender(false);
      addToast('Gender saved', 'success');
    } catch { addToast('Failed to save', 'error'); }
    finally { setSavingGender(false); }
  };

  const savePhone = async () => {
    if (!currentUser?.uid) return;
    setSavingPhone(true);
    try {
      await dbService.updateUser('caregivers', currentUser.uid, { phone } as any);
      setEditingPhone(false);
      addToast('Phone number saved', 'success');
    } catch { addToast('Failed to save', 'error'); }
    finally { setSavingPhone(false); }
  };

  const handleZipChange = async (val: string) => {
    setZip(val);
    if (val.length !== 5 || !/^\d{5}$/.test(val)) return;
    setZipLookingUp(true);
    try {
      const res = await fetch(`https://api.zippopotam.us/us/${val}`);
      if (!res.ok) return;
      const data = await res.json();
      const place = data.places?.[0];
      if (place) {
        setCity(place['place name'] || '');
        setState(place['state abbreviation'] || '');
      }
    } catch { /* best effort */ }
    finally { setZipLookingUp(false); }
  };

  const saveAddress = async () => {
    if (!currentUser?.uid) return;
    setSavingAddress(true);
    try {
      // Geocode so job-board distance filtering works instantly
      const coords = await geocodeToLatLng(street, city, state, zip);
      await dbService.updateUser('caregivers', currentUser.uid, {
        street, zipCode: zip, city, state,
        location: city && state ? `${city}, ${state}` : city || '',
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
      } as any);
      setEditingAddress(false);
      addToast('Address saved', 'success');
    } catch { addToast('Failed to save', 'error'); }
    finally { setSavingAddress(false); }
  };

  const handlePasswordChange = async () => {
    if (!currentPassword) { addToast('Enter your current password', 'error'); return; }
    if (!newPassword) { addToast('Enter a new password', 'error'); return; }
    if (newPassword !== confirmPassword) { addToast('Passwords do not match', 'error'); return; }
    if (newPassword.length < 6) { addToast('Password must be at least 6 characters', 'error'); return; }
    setSavingPassword(true);
    try {
      await authService.updateUserPassword(newPassword, currentPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setShowPasswordForm(false);
      addToast('Password updated', 'success');
    } catch (e: any) {
      const msg = e?.code === 'auth/wrong-password' ? 'Current password is incorrect' : 'Failed to update password';
      addToast(msg, 'error');
    } finally {
      setSavingPassword(false);
    }
  };

  const handleTransportUpload = useCallback(async (type: DocumentType, file: File) => {
    if (!currentUser?.uid) return;
    setTransportStatus(prev => ({ ...prev, [type]: 'uploading' }));
    try {
      const doc = await documentUploadService.uploadDocument(currentUser.uid, file, type);
      setProfile(prev => prev ? { ...prev, documents: { ...(prev as any).documents, [type]: doc } } as any : prev);
      setTransportStatus(prev => ({ ...prev, [type]: 'done' }));
      addToast('Document uploaded', 'success');
    } catch {
      setTransportStatus(prev => ({ ...prev, [type]: 'error' }));
      addToast('Upload failed. Please try again.', 'error');
    }
  }, [currentUser?.uid, addToast]);

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
      setDeleteError(err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential'
        ? 'Incorrect password. Please try again.'
        : 'Failed to delete account. Please try again.');
    }
  };

  const memberSince = (profile as any)?.createdAt
    ? new Date((profile as any).createdAt).toLocaleDateString() : '—';
  const hasTransportation = ((profile as any)?.skills || (profile as any)?.services || []).includes('Transportation');

  return (
    <>
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Account Settings</h1>

        {/* ── Account Basics ── */}
        <Accordion open={openAccount} onToggle={() => setOpenAccount(o => !o)} title="Account Basics">
          <div className="p-5 space-y-4">

            <p className="text-xs text-slate-400">Member since {memberSince}</p>

            {/* Name — read only */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <ReadOnly value={firstName} />
              </Field>
              <Field label="Last name">
                <ReadOnly value={lastName} />
              </Field>
            </div>

            {/* DOB — read only, MM/DD/YYYY */}
            <Field label="Date of birth">
              <ReadOnly value={formatDob(dob)} />
            </Field>

            {/* Gender — edit/save toggle */}
            <Field label="Gender">
              {editingGender ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {GENDER_OPTIONS.map(g => (
                      <button key={g} onClick={() => setGender(g)}
                        className={`px-3 py-1.5 rounded-full border text-sm transition-all ${
                          gender === g ? 'bg-primary-500 border-primary-500 text-white' : 'border-slate-200 text-slate-600 hover:border-slate-400'
                        }`}>
                        {g}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={saveGender} disabled={savingGender}
                      className="px-4 py-1.5 rounded-full bg-primary-500 text-white text-xs font-semibold hover:bg-primary-600 disabled:opacity-40">
                      {savingGender ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => setEditingGender(false)}
                      className="px-4 py-1.5 rounded-full border border-slate-200 text-xs text-slate-500 hover:bg-slate-50">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <EditableRow value={gender || '—'} onEdit={() => setEditingGender(true)} />
              )}
            </Field>

            {/* Email — read only */}
            <Field label="Email address">
              <ReadOnly value={profile?.email || ''} />
            </Field>

            {/* Password */}
            <Field label="Password">
              {!showPasswordForm ? (
                <button onClick={() => setShowPasswordForm(true)}
                  className="text-sm text-primary-600 hover:underline font-medium">
                  Change password
                </button>
              ) : (
                <div className="space-y-2">
                  <input type="password" placeholder="Current password" value={currentPassword}
                    onChange={e => setCurrentPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-primary-400" />
                  <input type="password" placeholder="New password" value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-primary-400" />
                  <input type="password" placeholder="Confirm new password" value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-primary-400" />
                  <div className="flex gap-2">
                    <button onClick={handlePasswordChange} disabled={savingPassword}
                      className="px-4 py-1.5 rounded-full bg-primary-500 text-white text-xs font-semibold hover:bg-primary-600 disabled:opacity-40">
                      {savingPassword ? 'Updating…' : 'Update password'}
                    </button>
                    <button onClick={() => { setShowPasswordForm(false); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); }}
                      className="px-4 py-1.5 rounded-full border border-slate-200 text-xs text-slate-500 hover:bg-slate-50">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Field>

            {/* Phone — edit/save toggle */}
            <Field label="Phone number">
              {editingPhone ? (
                <div className="space-y-2">
                  <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(xxx) xxx-xxxx"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-primary-400" />
                  <div className="flex gap-2">
                    <button onClick={savePhone} disabled={savingPhone}
                      className="px-4 py-1.5 rounded-full bg-primary-500 text-white text-xs font-semibold hover:bg-primary-600 disabled:opacity-40">
                      {savingPhone ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => setEditingPhone(false)}
                      className="px-4 py-1.5 rounded-full border border-slate-200 text-xs text-slate-500 hover:bg-slate-50">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <EditableRow value={phone || '—'} onEdit={() => setEditingPhone(true)} />
              )}
            </Field>

            {/* Address — edit/save toggle */}
            <Field label="Address">
              {editingAddress ? (
                <div className="space-y-2">
                  <input value={street} onChange={e => setStreet(e.target.value)} placeholder="Street"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-primary-400" />
                  <div className="grid grid-cols-3 gap-2">
                    <div className="relative">
                      <input value={zip} onChange={e => handleZipChange(e.target.value)} placeholder="Zip" maxLength={5}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-primary-400" />
                      {zipLookingUp && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">…</span>}
                    </div>
                    <input value={city} onChange={e => setCity(e.target.value)} placeholder="City"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-primary-400" />
                    <input value={state} onChange={e => setState(e.target.value)} placeholder="State"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-primary-400" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={saveAddress} disabled={savingAddress}
                      className="px-4 py-1.5 rounded-full bg-primary-500 text-white text-xs font-semibold hover:bg-primary-600 disabled:opacity-40">
                      {savingAddress ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => setEditingAddress(false)}
                      className="px-4 py-1.5 rounded-full border border-slate-200 text-xs text-slate-500 hover:bg-slate-50">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm text-slate-700">{street || '—'}</p>
                    {(city || state || zip) && (
                      <p className="text-xs text-slate-500 mt-0.5">{[city, state, zip].filter(Boolean).join(', ')}</p>
                    )}
                  </div>
                  <button onClick={() => setEditingAddress(true)}
                    className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium flex-shrink-0">
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                </div>
              )}
            </Field>

          </div>
        </Accordion>

        {/* ── Transportation Documents ── */}
        {hasTransportation && (
          <Accordion
            open={openTransport}
            onToggle={() => setOpenTransport(o => !o)}
            title="Transportation Documents"
            badge={Object.values(transportStatus).some(s => s === 'expired' || s === 'rejected')
              ? <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs font-semibold rounded-full">Action needed</span>
              : undefined}
          >
            <div className="p-5 space-y-4">
              <p className="text-sm text-slate-500">Required to activate your transportation badge. Keep these up to date.</p>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                <p className="text-xs text-amber-800">
                  Our team reviews these before approving your transportation services. Upload all three to avoid delays.
                </p>
              </div>

              <div className="space-y-3">
                {TRANSPORT_DOCS.map(({ type, label, desc }) => (
                  <div key={type} className={`border-2 rounded-xl p-3 flex items-center gap-3 transition-all ${
                    transportStatus[type] === 'approved' ? 'border-green-300 bg-green-50'
                    : transportStatus[type] === 'expired' ? 'border-orange-300 bg-orange-50'
                    : transportStatus[type] === 'rejected' ? 'border-red-300 bg-red-50'
                    : transportStatus[type] === 'done' ? 'border-amber-300 bg-amber-50'
                    : 'border-slate-200'
                  }`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{label}</p>
                      <p className="text-xs text-slate-500">{desc}</p>
                      {transportExpiry[type] && (
                        <p className="text-xs text-slate-400 mt-0.5">
                          Expires {(() => { const [y,m,d] = transportExpiry[type]!.split('-'); return new Date(+y, +m-1, +d).toLocaleDateString(); })()}
                        </p>
                      )}
                    </div>
                    {transportStatus[type] === 'approved' ? (
                      <span className="flex items-center gap-1 text-green-700 text-xs font-medium shrink-0">
                        <CheckCircle className="w-3.5 h-3.5" /> Approved
                      </span>
                    ) : transportStatus[type] === 'expired' ? (
                      <button onClick={() => transportRefs[type].current?.click()}
                        className="flex items-center gap-1 text-orange-700 text-xs font-semibold border border-orange-300 px-3 py-1.5 rounded-lg hover:bg-orange-100 shrink-0">
                        <AlertCircle className="w-3.5 h-3.5" /> Expired — Re-upload
                      </button>
                    ) : transportStatus[type] === 'rejected' ? (
                      <button onClick={() => transportRefs[type].current?.click()}
                        className="flex items-center gap-1 text-red-700 text-xs font-semibold border border-red-300 px-3 py-1.5 rounded-lg hover:bg-red-100 shrink-0">
                        <AlertCircle className="w-3.5 h-3.5" /> Rejected — Re-upload
                      </button>
                    ) : transportStatus[type] === 'done' ? (
                      <span className="flex items-center gap-1 text-amber-700 text-xs font-medium shrink-0">
                        <Clock className="w-3.5 h-3.5" /> Under Review
                      </span>
                    ) : transportStatus[type] === 'uploading' ? (
                      <Loader2 className="w-4 h-4 animate-spin text-primary-500 shrink-0" />
                    ) : (
                      <button
                        onClick={() => transportRefs[type].current?.click()}
                        className={`shrink-0 text-xs font-semibold border px-3 py-1.5 rounded-lg transition-colors ${
                          transportStatus[type] === 'error'
                            ? 'border-red-300 text-red-600 hover:bg-red-50'
                            : 'border-primary-200 text-primary-600 hover:bg-primary-50'
                        }`}
                      >
                        {transportStatus[type] === 'error' ? 'Retry' : 'Upload'}
                      </button>
                    )}
                    <input
                      ref={transportRefs[type]}
                      type="file"
                      accept="image/*,application/pdf"
                      className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleTransportUpload(type, f); e.target.value = ''; }}
                    />
                  </div>
                ))}
              </div>

              {TRANSPORT_DOCS.filter(d => ['done', 'approved'].includes(transportStatus[d.type])).length < 3 && (
                <p className="text-center text-xs text-amber-600 font-medium">
                  All three documents are required to activate the transportation badge.
                </p>
              )}
            </div>
          </Accordion>
        )}

        {/* ── Blocked Users ── */}
        <Accordion open={openBlocked} onToggle={() => setOpenBlocked(o => !o)} title="Blocked Users">
          <div className="p-5">
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
                      onClick={() => unblockUser(p.id).then(() => addToast(`${p.name} unblocked.`, 'success'))}
                      className="text-xs text-primary-600 hover:text-primary-700 font-medium border border-primary-200 hover:border-primary-400 px-3 py-1 rounded-lg transition-colors"
                    >
                      Unblock
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Accordion>

        {/* ── Delete Account ── */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-3 p-5">
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

    {/* ── Delete Account Modal ── */}
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
    </>
  );
};

const Accordion: React.FC<{ open: boolean; onToggle: () => void; title: string; badge?: React.ReactNode; children: React.ReactNode }> = ({ open, onToggle, title, badge, children }) => (
  <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-3">
    <button onClick={onToggle} className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-slate-50 transition-colors">
      <span className="flex items-center gap-2">
        <span className="font-semibold text-slate-900">{title}</span>
        {badge}
      </span>
      {open ? <ChevronDown className="w-5 h-5 text-slate-400" /> : <ChevronRight className="w-5 h-5 text-slate-400" />}
    </button>
    {open && <div className="border-t border-slate-100">{children}</div>}
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
    {children}
  </div>
);

const ReadOnly: React.FC<{ value: string }> = ({ value }) => (
  <p className="text-sm text-slate-700">{value || '—'}</p>
);

const EditableRow: React.FC<{ value: string; onEdit: () => void }> = ({ value, onEdit }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="text-sm text-slate-700">{value}</span>
    <button onClick={onEdit}
      className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium flex-shrink-0">
      <Pencil className="w-3 h-3" /> Edit
    </button>
  </div>
);
