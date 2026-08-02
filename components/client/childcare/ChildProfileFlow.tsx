// ── Secure child-profile completion flow (plan 2026-07-22-002, U4) ──────────
//
// The AUTHENTICATED web form where child details are collected — never SMS,
// never URLs (R33 / implementation defaults). Everything goes through the U3
// callables (v1-createChildProfile etc.); the browser NEVER writes child data
// to Firestore directly (R11), and private safety fields are held in React
// state only — no localStorage/sessionStorage/IndexedDB persistence, cleared
// on submit. Resumable from canonical state: v1-listMyChildren +
// v1-getMyHouseholdState on mount.
//
// Identity gate (R17/R22): v1-createChildcareIdentitySession returns a hosted
// Stripe URL plus a ONE-TIME callback state; the state (an opaque nonce, not
// a private field) is parked in sessionStorage across the Stripe redirect and
// presented to v1-consumeChildcareIdentityCallback on return — URL params
// grant nothing.
//
// Plain functional UI — visual polish is U11.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { functions } from '../../../lib/firebase';
import { childcareCallable } from '../../../lib/childcareCallable';

// sessionStorage key for the identity callback nonce (NOT child data).
export const IDENTITY_STATE_STORAGE_KEY = 'evia.childcare.identityState';

// Enableable pilot categories (jurisdictionPolicy CA seed; deferred
// categories — overnight/medication/infant/specialized — are server-rejected).
const CARE_CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'babysitting', label: 'Babysitting' },
  { value: 'nanny_care', label: 'Nanny care' },
  { value: 'after_school_care', label: 'After-school care' },
  { value: 'date_night_care', label: 'Date-night care' },
];

// R23: the guardian attestation is a VERSIONED receipt. Until the founder
// populates jurisdiction consentVersions, receipts record the pending state —
// activation stays blocked by the U1 readiness evaluator either way.
const GUARDIAN_ATTESTATION_VERSION_FALLBACK = 'pending-policy-version';

interface ChildSummary {
  childId: string;
  displayLabel: string;
  ageBand: string;
  careCategories: string[];
  safetyCurrentVersion: number;
}

interface HouseholdSummary {
  householdId: string;
  isPrimary: boolean;
}

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function callableErrorCode(err: unknown): string {
  return String((err as { details?: { code?: string } })?.details?.code ?? '');
}

export const ChildProfileFlow: React.FC = () => {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [households, setHouseholds] = useState<HouseholdSummary[]>([]);
  const [children, setChildren] = useState<ChildSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add-child form (operational fields + the DOB the private zone requires).
  const [displayLabel, setDisplayLabel] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const createKeyRef = useRef<string>(newIdempotencyKey());

  // Safety-details form for one child — React state ONLY (never persisted).
  const [safetyChildId, setSafetyChildId] = useState<string | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactRelationship, setContactRelationship] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [healthNotes, setHealthNotes] = useState('');
  const [allergiesNote, setAllergiesNote] = useState('');
  const [pickupNotes, setPickupNotes] = useState('');
  const safetyKeyRef = useRef<string>(newIdempotencyKey());

  // Identity gate state.
  const [identityStatus, setIdentityStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!functions) { setLoadState('error'); return; }
    try {
      const [householdResp, childrenResp] = await Promise.all([
        childcareCallable('getMyHouseholdState')({}),
        childcareCallable('listMyChildren')({}),
      ]);
      const householdData = householdResp.data as { households?: HouseholdSummary[] };
      const childrenData = childrenResp.data as { children?: ChildSummary[] };
      setHouseholds(householdData?.households ?? []);
      setChildren(childrenData?.children ?? []);
      setLoadState('ready');
    } catch (err) {
      if (callableErrorCode(err) === 'childcare_disabled') setLoadState('unavailable');
      else setLoadState('error');
    }
  }, []);

  // Mount: resume from canonical state + consume an identity return if present.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!functions) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('identity') !== 'return') return;
    const state = window.sessionStorage.getItem(IDENTITY_STATE_STORAGE_KEY);
    // One-time: the nonce leaves storage before the consume round-trip.
    window.sessionStorage.removeItem(IDENTITY_STATE_STORAGE_KEY);
    if (!state) return;
    childcareCallable('consumeChildcareIdentityCallback')({ state })
      .then((resp) => {
        const status = String((resp.data as { status?: string })?.status ?? '');
        setIdentityStatus(status);
        if (status === 'verified') setNotice('Identity verified — thank you!');
        else if (status === 'processing') setNotice('Identity check submitted — Stripe is reviewing it.');
        else if (status === 'requires_input') setNotice('The identity check needs another attempt.');
        else if (status === 'canceled') setNotice('The identity check was canceled — you can restart it below.');
      })
      .catch(() => {
        setNotice('That verification link expired or was already used — start the check again below.');
      });
  }, []);

  const startIdentityCheck = async () => {
    if (!functions || busy) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await childcareCallable('createChildcareIdentitySession')({});
      const data = resp.data as { url?: string | null; status?: string; callbackState?: string };
      setIdentityStatus(data?.status ?? null);
      if (data?.status === 'verified') {
        setNotice('You are already verified.');
      } else if (data?.url && data?.callbackState) {
        window.sessionStorage.setItem(IDENTITY_STATE_STORAGE_KEY, data.callbackState);
        window.location.assign(data.url);
      } else {
        setNotice('Verification is still processing — check back shortly.');
      }
    } catch (err) {
      setError(callableErrorCode(err) === 'childcare_disabled'
        ? 'Childcare features are not available yet.'
        : 'Could not start the identity check. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const toggleCategory = (value: string) => {
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const addChild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!functions || busy) return;
    if (!displayLabel.trim() || !dateOfBirth || categories.size === 0) {
      setError('Please add a name, date of birth, and at least one care type.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let householdId = households[0]?.householdId;
      if (!householdId) {
        const created = await childcareCallable('createHousehold')({});
        householdId = String((created.data as { householdId?: string })?.householdId ?? '');
      }
      if (!householdId) throw new Error('no household');
      await childcareCallable('createChildProfile')({
        householdId,
        displayLabel: displayLabel.trim(),
        careCategories: [...categories],
        // Exact DOB goes straight to the server's PRIVATE zone — it is never
        // echoed back to the browser (the summary carries the age band only).
        safety: { dateOfBirth },
        idempotencyKey: createKeyRef.current,
        guardianAttestationVersion: GUARDIAN_ATTESTATION_VERSION_FALLBACK,
      });
      // Clear the form (and the private DOB) immediately; new key for the next child.
      setDisplayLabel('');
      setDateOfBirth('');
      setCategories(new Set());
      createKeyRef.current = newIdempotencyKey();
      setNotice('Child profile created.');
      await refresh();
    } catch (err) {
      const code = callableErrorCode(err);
      if (code === 'childcare_disabled') setError('Childcare features are not available yet.');
      else if (code === 'recent_auth_required') setError('Please sign in again to add a child profile (security check).');
      else setError('Could not save the child profile. Please check the details and try again.');
    } finally {
      setBusy(false);
    }
  };

  const clearSafetyForm = () => {
    setSafetyChildId(null);
    setContactName('');
    setContactRelationship('');
    setContactPhone('');
    setHealthNotes('');
    setAllergiesNote('');
    setPickupNotes('');
    safetyKeyRef.current = newIdempotencyKey();
  };

  const submitSafety = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!functions || busy || !safetyChildId) return;
    setBusy(true);
    setError(null);
    try {
      // Straight to appendChildSafetyVersion — the private payload is sent
      // once and dropped from local state on success (no local persistence).
      await childcareCallable('appendChildSafetyVersion')({
        childId: safetyChildId,
        safety: {
          ...(contactName && contactRelationship && contactPhone
            ? { emergencyContacts: [{ name: contactName, relationship: contactRelationship, phone: contactPhone }] }
            : {}),
          ...(healthNotes ? { healthNotes } : {}),
          ...(allergiesNote ? { allergiesNote } : {}),
          ...(pickupNotes ? { pickupNotes } : {}),
        },
        idempotencyKey: safetyKeyRef.current,
      });
      clearSafetyForm();
      setNotice('Safety details saved securely.');
      await refresh();
    } catch (err) {
      const code = callableErrorCode(err);
      if (code === 'recent_auth_required') setError('Please sign in again to update safety details (security check).');
      else setError('Could not save the safety details. Please check the fields and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loadState === 'loading') {
    return <div className="p-8 text-center text-ink-600">Loading your childcare setup…</div>;
  }
  if (loadState === 'unavailable') {
    return (
      <div className="p-8 max-w-lg mx-auto text-center space-y-2">
        <h1 className="text-xl font-semibold text-ink-900">Childcare is coming soon</h1>
        <p className="text-ink-600">Childcare features are not available in your area yet. We will let you know the moment they open up.</p>
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="p-8 max-w-lg mx-auto text-center space-y-3">
        <p className="text-ink-600">We could not load your childcare setup.</p>
        <button onClick={() => { setLoadState('loading'); void refresh(); }} className="px-5 py-2.5 rounded-full bg-ink-900 text-white font-semibold">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-ink-900">Your childcare setup</h1>
        <p className="text-ink-600 text-sm">
          Child details are collected only here, in your secure account — never over text.
        </p>
      </header>

      {notice && <div role="status" className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">{notice}</div>}
      {error && <div role="alert" className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}

      {/* Identity gate */}
      <section className="rounded-2xl border hairline bg-white p-5 space-y-3">
        <h2 className="font-semibold text-ink-900">Identity verification</h2>
        <p className="text-sm text-ink-600">
          A quick ID check (via Stripe) is required before booking childcare.
          {identityStatus ? ` Current status: ${identityStatus}.` : ''}
        </p>
        <button
          onClick={startIdentityCheck}
          disabled={busy || identityStatus === 'verified'}
          className="px-5 py-2.5 rounded-full bg-ink-900 text-white font-semibold text-sm disabled:opacity-40"
        >
          {identityStatus === 'verified' ? 'Verified' : 'Verify my identity'}
        </button>
      </section>

      {/* Existing children (resume from canonical state) */}
      <section className="space-y-3">
        <h2 className="font-semibold text-ink-900">Children</h2>
        {children.length === 0 && <p className="text-sm text-ink-600">No child profiles yet.</p>}
        {children.map((child) => (
          <div key={child.childId} className="rounded-2xl border hairline bg-white p-4 flex items-center justify-between gap-3">
            <div>
              <div className="font-medium text-ink-900">{child.displayLabel}</div>
              <div className="text-xs text-ink-600">
                Age band: {child.ageBand} · {child.careCategories.join(', ')}
                {child.safetyCurrentVersion > 0 ? ' · safety details on file' : ' · safety details needed'}
              </div>
            </div>
            <button
              onClick={() => { clearSafetyForm(); setSafetyChildId(child.childId); }}
              className="px-4 py-2 rounded-full border hairline text-sm font-medium text-ink-900 flex-shrink-0"
            >
              {child.safetyCurrentVersion > 0 ? 'Update safety details' : 'Add safety details'}
            </button>
          </div>
        ))}
      </section>

      {/* Safety details form — private zone, in-memory only */}
      {safetyChildId && (
        <form onSubmit={submitSafety} className="rounded-2xl border hairline bg-white p-5 space-y-3">
          <h2 className="font-semibold text-ink-900">Private safety details</h2>
          <p className="text-xs text-ink-600">
            Stored in a restricted area and shared only with a confirmed caregiver for an active booking.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input aria-label="Emergency contact name" placeholder="Contact name" value={contactName}
              onChange={(e) => setContactName(e.target.value)} className="border hairline rounded-xl px-3 py-2 text-sm" />
            <input aria-label="Emergency contact relationship" placeholder="Relationship" value={contactRelationship}
              onChange={(e) => setContactRelationship(e.target.value)} className="border hairline rounded-xl px-3 py-2 text-sm" />
            <input aria-label="Emergency contact phone" placeholder="+14085551234" value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)} className="border hairline rounded-xl px-3 py-2 text-sm" />
          </div>
          <textarea aria-label="Health notes" placeholder="Health notes (optional)" value={healthNotes}
            onChange={(e) => setHealthNotes(e.target.value)} className="w-full border hairline rounded-xl px-3 py-2 text-sm" />
          <textarea aria-label="Allergies" placeholder="Allergies (optional)" value={allergiesNote}
            onChange={(e) => setAllergiesNote(e.target.value)} className="w-full border hairline rounded-xl px-3 py-2 text-sm" />
          <textarea aria-label="Pickup notes" placeholder="Pickup notes (optional)" value={pickupNotes}
            onChange={(e) => setPickupNotes(e.target.value)} className="w-full border hairline rounded-xl px-3 py-2 text-sm" />
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className="px-5 py-2.5 rounded-full bg-ink-900 text-white font-semibold text-sm disabled:opacity-40">
              Save safety details
            </button>
            <button type="button" onClick={clearSafetyForm} className="px-5 py-2.5 rounded-full border hairline text-sm font-medium">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Add-child form */}
      <form onSubmit={addChild} className="rounded-2xl border hairline bg-white p-5 space-y-3">
        <h2 className="font-semibold text-ink-900">Add a child</h2>
        <input
          aria-label="Child name"
          placeholder="Child's first name or nickname"
          value={displayLabel}
          maxLength={80}
          onChange={(e) => setDisplayLabel(e.target.value)}
          className="w-full border hairline rounded-xl px-3 py-2 text-sm"
        />
        <label className="block text-sm text-ink-600">
          Date of birth (kept private — only an age band is ever shown)
          <input
            aria-label="Date of birth"
            type="date"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
            className="mt-1 w-full border hairline rounded-xl px-3 py-2 text-sm"
          />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-sm text-ink-600">Care types</legend>
          {CARE_CATEGORY_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm text-ink-900">
              <input
                type="checkbox"
                checked={categories.has(opt.value)}
                onChange={() => toggleCategory(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={busy} className="px-5 py-2.5 rounded-full bg-ink-900 text-white font-semibold text-sm disabled:opacity-40">
          Add child
        </button>
      </form>
    </div>
  );
};

export default ChildProfileFlow;
