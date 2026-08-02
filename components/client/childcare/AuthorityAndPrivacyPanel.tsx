// ── AuthorityAndPrivacyPanel (plan 2026-07-22-002, U11) ──────────────────────
//
// Household adults, per-child scopes, invites, revocation, and the U3 data
// lifecycle entry points (export / delete / status). Callable-only (R11):
//   • v1-getMyHouseholdState + v1-listMyChildren (own view)
//   • v1-listHouseholdMembers — DOCUMENTED U11 SEAM: the server does not yet
//     expose other adults' memberships/authorities (getMyHouseholdState is
//     deliberately own-records-only). Until it lands, the adults panel shows
//     an explicit "can't list other adults" state; revocation renders from
//     that seam's response, never from re-derived client guesses.
//   • v1-inviteHouseholdAdult — high-risk (recent auth); the raw invite token
//     is returned ONCE and shown ONCE for the inviter to deliver; it is never
//     persisted locally (R57).
//   • v1-revokeGuardianAuthority — high-risk; surfaces the dispute-hold state
//     (R18 co-guardian contract) verbatim from the server response.
//   • v1-requestChildDataExport / v1-requestChildDataDeletion /
//     v1-getLifecycleRequestStatus — the U3 lifecycle callables (R14/R15;
//     deliberately usable even while childcare flags are off).
//
// UI hides what checkAuthority would deny by DRIVING from callable responses
// (own scopes, membership role) — it never re-derives authority client-side.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, Loader2, ShieldCheck, Trash2, UserPlus, UserX } from 'lucide-react';
import { functions } from '../../../lib/firebase';
import {
  childcareCallable,
  type ChildcareCallableName,
} from '../../../lib/childcareCallable';
import { ClientNavigation } from '../ClientNavigation';
import {
  ageBandLabel,
  callableErrorCode,
  categoryLabel,
  isChildcareDisabledError,
  newIdempotencyKey,
  type AuthoritySummary,
  type ChildSummary,
  type HouseholdSummary,
} from '../../shared/childcareAccess';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

const SCOPE_OPTIONS = ['view', 'schedule', 'messaging', 'pickup', 'emergency', 'cancellation', 'payment'] as const;

interface HouseholdMemberRow {
  adultUid: string;
  displayLabel?: string;
  role?: string;
  membershipStatus?: string;
  authorities?: Array<{ childId: string; scopes: string[]; state: string; expiresAt?: string | null; accessVersion?: number }>;
}

function authorityStateCopy(a: AuthoritySummary): string | null {
  if (a.state === 'revoked') return 'Access revoked';
  if (a.state === 'expired') return 'Access expired — ask the primary adult to re-grant it if still needed';
  if (a.state === 'dispute_hold') return 'Under dispute review — an operator will follow up';
  if (a.expiresAt && Date.parse(a.expiresAt) < Date.now()) return 'Access expired — ask the primary adult to re-grant it if still needed';
  return null;
}

export const AuthorityAndPrivacyPanel: React.FC = () => {
  const navigate = useNavigate();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [households, setHouseholds] = useState<HouseholdSummary[]>([]);
  const [authorities, setAuthorities] = useState<AuthoritySummary[]>([]);
  const [children, setChildren] = useState<ChildSummary[]>([]);
  const [members, setMembers] = useState<HouseholdMemberRow[] | null>(null);
  const [membersUnavailable, setMembersUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Invite form.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteChannel, setInviteChannel] = useState<'sms' | 'email'>('sms');
  const [inviteContact, setInviteContact] = useState('');
  const [inviteScopes, setInviteScopes] = useState<Record<string, Set<string>>>({});
  const [issuedInviteToken, setIssuedInviteToken] = useState<string | null>(null);
  const inviteKeyRef = useRef(newIdempotencyKey());

  // Lifecycle status.
  const [lifecycleRequestId, setLifecycleRequestId] = useState<string | null>(null);
  const [lifecycleState, setLifecycleState] = useState<string | null>(null);

  const primaryHousehold = households.find((h) => h.isPrimary) ?? households[0] ?? null;
  const isPrimary = primaryHousehold?.isPrimary === true;

  const loadMembers = useCallback(async (householdId: string) => {
    if (!functions) { setMembersUnavailable(true); return; }
    setMembersUnavailable(false);
    try {
      // U11 seam — see module header.
      const resp = await childcareCallable('listHouseholdMembers')({ householdId });
      setMembers(((resp.data as { members?: HouseholdMemberRow[] })?.members) ?? []);
    } catch {
      setMembers(null);
      setMembersUnavailable(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!functions) { setLoadState('error'); return; }
    try {
      const [householdResp, childrenResp] = await Promise.all([
        childcareCallable('getMyHouseholdState')({}),
        childcareCallable('listMyChildren')({}),
      ]);
      const householdData = householdResp.data as { households?: HouseholdSummary[]; authorities?: AuthoritySummary[] };
      const nextHouseholds = householdData?.households ?? [];
      setHouseholds(nextHouseholds);
      setAuthorities(householdData?.authorities ?? []);
      setChildren(((childrenResp.data as { children?: ChildSummary[] })?.children) ?? []);
      setLoadState('ready');
      const hh = nextHouseholds.find((h) => h.isPrimary) ?? nextHouseholds[0];
      if (hh) void loadMembers(hh.householdId);
      else setMembers([]);
    } catch (err) {
      setLoadState(isChildcareDisabledError(err) ? 'unavailable' : 'error');
    }
  }, [loadMembers]);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggleInviteScope = (childId: string, scope: string) => {
    setInviteScopes((prev) => {
      const next = { ...prev };
      const set = new Set(next[childId] ?? []);
      if (set.has(scope)) set.delete(scope);
      else set.add(scope);
      next[childId] = set;
      return next;
    });
  };

  const mapActionError = (err: unknown, fallback: string): string => {
    const code = callableErrorCode(err);
    if (code === 'childcare_disabled') return 'Childcare features are not available right now.';
    if (code === 'recent_auth_required') return 'This is a sensitive change — please sign in again, then retry (security check).';
    if (code === 'stale_access_version') return 'This access changed since you loaded the page. Refresh and try again.';
    return fallback;
  };

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!functions || !primaryHousehold || busy) return;
    if (!inviteContact.trim()) {
      setError('Add the adult’s phone number or email to send an invite.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const proposedScopes = Object.entries(inviteScopes)
        .filter(([, scopes]) => scopes.size > 0)
        .map(([childId, scopes]) => ({ childId, scopes: [...scopes] }));
      const resp = await childcareCallable('inviteHouseholdAdult')({
        householdId: primaryHousehold.householdId,
        intendedContact: { channel: inviteChannel, value: inviteContact.trim() },
        proposedScopes,
        idempotencyKey: inviteKeyRef.current,
      });
      const data = resp.data as { inviteToken?: string; alreadyExisted?: boolean };
      inviteKeyRef.current = newIdempotencyKey();
      if (data?.inviteToken) {
        setIssuedInviteToken(data.inviteToken);
        setNotice('Invite created. Share the one-time code below with the invited adult — it is shown only once.');
      } else if (data?.alreadyExisted) {
        setNotice('This invite was already created — its one-time code was shown when it was first issued.');
      }
      setInviteContact('');
      setInviteScopes({});
      setInviteOpen(false);
    } catch (err) {
      setError(mapActionError(err, 'Could not create the invite. Please check the details and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const revokeAuthority = async (member: HouseholdMemberRow, childId: string, accessVersion?: number) => {
    if (!functions || !primaryHousehold || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await childcareCallable('revokeGuardianAuthority')({
        householdId: primaryHousehold.householdId,
        childId,
        targetAdultUid: member.adultUid,
        ...(accessVersion != null ? { expectedAccessVersion: accessVersion } : {}),
        idempotencyKey: newIdempotencyKey(),
      });
      const data = resp.data as { disputeHold?: boolean };
      setNotice(data?.disputeHold
        ? 'Because this adult holds current authority, the change enters a dispute hold: they are notified and an operator reviews it before access ends.'
        : 'Access revoked. All derived access (bookings, files, chat) is withdrawn.');
      void refresh();
    } catch (err) {
      setError(mapActionError(err, 'Could not revoke access. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const requestLifecycle = async (childId: string, kind: 'export' | 'delete') => {
    if (!functions || busy) return;
    if (kind === 'delete' && !window.confirm(
      'Delete this child’s data? This starts a tracked deletion workflow. Records required for financial, dispute, safety, or legal reasons are retained; everything else is removed. This cannot be undone.',
    )) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const name: ChildcareCallableName =
        kind === 'export' ? 'requestChildDataExport' : 'requestChildDataDeletion';
      const resp = await childcareCallable(name)({ childId, idempotencyKey: newIdempotencyKey() });
      const data = resp.data as { requestId?: string; state?: string };
      setLifecycleRequestId(data?.requestId ?? null);
      setLifecycleState(data?.state ?? null);
      setNotice(kind === 'export'
        ? 'Export requested. We will prepare the data and update the status below.'
        : 'Deletion requested. Progress is tracked below until every eligible record reaches a final state.');
    } catch (err) {
      setError(mapActionError(err, 'Could not start that request. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const checkLifecycleStatus = async () => {
    if (!functions || !lifecycleRequestId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await childcareCallable('getLifecycleRequestStatus')({ requestId: lifecycleRequestId });
      const data = resp.data as { state?: string };
      setLifecycleState(data?.state ?? 'unknown');
    } catch {
      setError('Could not check the request status. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="flex justify-center py-24" role="status" aria-label="Loading authority and privacy">
          <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
        </div>
      </div>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-2">
          <h1 className="text-xl font-semibold text-slate-900">Childcare is coming soon</h1>
          <p className="text-slate-500 text-sm">Childcare features are not available in your area yet.</p>
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4" role="alert">
          <p className="text-slate-600 text-sm">We could not load your household&apos;s access settings.</p>
          <button
            type="button"
            onClick={() => { setLoadState('loading'); void refresh(); }}
            className="px-5 py-2.5 rounded-full bg-slate-900 text-white text-sm font-semibold"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <button
          type="button"
          onClick={() => navigate('/childcare')}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Back to childcare
        </button>

        <header>
          <h1 className="text-2xl font-bold text-slate-900">Authority &amp; privacy</h1>
          <p className="text-sm text-slate-500 mt-1">
            Who can see and act for each child, and your data rights. Household membership alone grants nothing —
            every permission is explicit and revocable.
          </p>
        </header>

        {notice && (
          <div role="status" className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {issuedInviteToken && (
          <div className="rounded-xl bg-slate-900 text-white px-4 py-3 text-sm space-y-1">
            <p className="font-semibold">One-time invite code (shown once):</p>
            <p className="font-mono break-all" data-testid="invite-token">{issuedInviteToken}</p>
            <p className="text-xs text-slate-300">
              Deliver it to the invited adult yourself. They enter it after signing in with their own account.
            </p>
            <button
              type="button"
              onClick={() => setIssuedInviteToken(null)}
              className="mt-1 text-xs underline"
            >
              I&apos;ve shared it — hide the code
            </button>
          </div>
        )}

        {/* ── My access ── */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary-600" aria-hidden="true" /> My access
          </h2>
          {households.length === 0 ? (
            <p className="text-sm text-slate-600">
              No household yet — one is created automatically when you add your first child profile.
            </p>
          ) : (
            households.map((h) => (
              <p key={h.householdId} className="text-sm text-slate-600">
                Household member{h.isPrimary ? ' · primary adult' : ''}
                {h.membershipRole && !h.isPrimary ? ` · ${categoryLabel(h.membershipRole)}` : ''}
              </p>
            ))
          )}
          {authorities.length === 0 ? (
            <p className="text-sm text-slate-500">You hold no per-child permissions yet.</p>
          ) : (
            <ul className="space-y-2">
              {authorities.map((a) => {
                const child = children.find((c) => c.childId === a.childId);
                const stateCopy = authorityStateCopy(a);
                return (
                  <li key={a.authorityId} className="border border-slate-100 rounded-xl p-3">
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {child ? `${child.displayLabel} (${ageBandLabel(child.ageBand)})` : 'A child in your household'}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {a.scopes.map((s) => (
                        <span key={s} className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">
                          {categoryLabel(s)}
                        </span>
                      ))}
                    </div>
                    {stateCopy && (
                      <p className="text-xs text-amber-700 mt-1" role="status">{stateCopy}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ── Household adults ── */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-900">Household adults</h2>
            {isPrimary && (
              <button
                type="button"
                onClick={() => setInviteOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold"
              >
                <UserPlus className="w-4 h-4" aria-hidden="true" /> Invite an adult
              </button>
            )}
          </div>

          {inviteOpen && isPrimary && (
            <form onSubmit={sendInvite} className="space-y-3 border border-slate-100 rounded-xl p-4">
              <div className="flex gap-2">
                <label className="text-xs text-slate-600 flex-shrink-0">
                  Contact via
                  <select
                    aria-label="Invite channel"
                    value={inviteChannel}
                    onChange={(e) => setInviteChannel(e.target.value === 'email' ? 'email' : 'sms')}
                    className="mt-1 block border border-slate-200 rounded-xl px-2 py-2 text-sm"
                  >
                    <option value="sms">Phone (SMS)</option>
                    <option value="email">Email</option>
                  </select>
                </label>
                <label className="text-xs text-slate-600 flex-1">
                  {inviteChannel === 'sms' ? 'Phone number' : 'Email address'}
                  <input
                    aria-label="Invite contact"
                    value={inviteContact}
                    onChange={(e) => setInviteContact(e.target.value)}
                    placeholder={inviteChannel === 'sms' ? '+14085551234' : 'adult@example.com'}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                  />
                </label>
              </div>
              {children.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-xs text-slate-600">
                    Permissions to propose (each child separately — nothing is inferred)
                  </legend>
                  {children.map((child) => (
                    <div key={child.childId} className="border border-slate-100 rounded-xl p-3">
                      <p className="text-sm font-medium text-slate-800 truncate">{child.displayLabel}</p>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {SCOPE_OPTIONS.map((scope) => (
                          <label key={scope} className="inline-flex items-center gap-1 text-xs text-slate-700">
                            <input
                              type="checkbox"
                              checked={inviteScopes[child.childId]?.has(scope) ?? false}
                              onChange={() => toggleInviteScope(child.childId, scope)}
                              aria-label={`${categoryLabel(scope)} for ${child.displayLabel}`}
                            />
                            {categoryLabel(scope)}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </fieldset>
              )}
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold disabled:opacity-40"
              >
                Create invite
              </button>
            </form>
          )}

          {membersUnavailable ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2" role="alert">
              <p className="text-sm text-amber-800">
                Other household adults can&apos;t be listed right now. Their access is unchanged — this view just
                failed to load.
              </p>
              {primaryHousehold && (
                <button
                  type="button"
                  onClick={() => void loadMembers(primaryHousehold.householdId)}
                  className="px-3 py-1.5 rounded-full border border-amber-300 text-amber-800 text-sm font-semibold flex-shrink-0 hover:bg-amber-100"
                >
                  Retry
                </button>
              )}
            </div>
          ) : members === null ? (
            <div className="flex justify-center py-4" role="status" aria-label="Loading household adults">
              <Loader2 className="w-5 h-5 animate-spin text-primary-500" />
            </div>
          ) : members.length === 0 ? (
            <p className="text-sm text-slate-500">No other adults have access yet.</p>
          ) : (
            <ul className="space-y-2">
              {members.map((member) => (
                <li key={member.adultUid} className="border border-slate-100 rounded-xl p-3 space-y-2">
                  <p className="text-sm font-medium text-slate-800 truncate">
                    {member.displayLabel || 'Household adult'}
                    {member.role ? ` · ${categoryLabel(member.role)}` : ''}
                  </p>
                  {(member.authorities ?? []).map((auth) => {
                    const child = children.find((c) => c.childId === auth.childId);
                    return (
                      <div key={`${member.adultUid}-${auth.childId}`} className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs text-slate-600 truncate">
                            {child?.displayLabel ?? 'Child'} · {auth.scopes.map(categoryLabel).join(', ') || 'no permissions'}
                            {auth.state !== 'active' ? ` · ${categoryLabel(auth.state)}` : ''}
                          </p>
                        </div>
                        {isPrimary && auth.state === 'active' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void revokeAuthority(member, auth.childId, auth.accessVersion)}
                            aria-label={`Revoke ${child?.displayLabel ?? 'child'} access for ${member.displayLabel || 'this adult'}`}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-red-200 text-red-600 text-xs font-semibold hover:bg-red-50 disabled:opacity-40"
                          >
                            <UserX className="w-3.5 h-3.5" aria-hidden="true" /> Revoke
                          </button>
                        )}
                      </div>
                    );
                  })}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Data rights (U3 lifecycle) ── */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="font-semibold text-slate-900">Data export &amp; deletion</h2>
          <p className="text-sm text-slate-600">
            You can export or delete a child&apos;s data at any time — even while childcare features are paused.
            Deletion is a tracked workflow, not a one-click wipe: required financial, dispute, safety, and legal
            records are retained; everything else is provably removed.
          </p>
          {children.length === 0 ? (
            <p className="text-sm text-slate-500">No child profiles yet.</p>
          ) : (
            <ul className="space-y-2">
              {children.map((child) => (
                <li key={child.childId} className="border border-slate-100 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-800 truncate">{child.displayLabel}</p>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void requestLifecycle(child.childId, 'export')}
                      aria-label={`Export data for ${child.displayLabel}`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" /> Export
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void requestLifecycle(child.childId, 'delete')}
                      aria-label={`Delete data for ${child.displayLabel}`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-red-200 text-red-600 text-xs font-semibold hover:bg-red-50 disabled:opacity-40"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {lifecycleRequestId && (
            <div className="border border-slate-100 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2" role="status">
              <p className="text-xs text-slate-600">
                Request <span className="font-mono">{lifecycleRequestId}</span>
                {lifecycleState ? ` · ${categoryLabel(lifecycleState)}` : ''}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void checkLifecycleStatus()}
                className="px-3 py-1.5 rounded-full border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40"
              >
                Check status
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default AuthorityAndPrivacyPanel;
