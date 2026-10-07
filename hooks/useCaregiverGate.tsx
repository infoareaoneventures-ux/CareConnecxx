import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, X } from 'lucide-react';
import { useCareConnex } from '../context/CareConnexContext';
import { hasValidTransportDocs, offersTransportation } from '../utils/transportDocs';

/** Where "Set Up Transportation" sends a caregiver who has not offered the service yet: the Profile page with the Care Services editor open (2026-10-06). */
export const ADD_TRANSPORTATION_PATH = '/caregiver/profile?edit=services';

/**
 * Where "Set Up Transportation" goes — the job-card button, the Apply popup's button and
 * Evia's texted twin agree (founder, 2026-10-06: the button went to Settings even when
 * Transportation wasn't on the profile). Not offering → the Care Services editor (the only
 * thing to do is add the service); offering → Settings, where the driving record card says
 * where it stands (nothing left to do but wait or read the result).
 */
export function transportSetupPath(profile: any): string {
  return offersTransportation(profile) ? '/caregiver/settings' : ADD_TRANSPORTATION_PATH;
}
import { dbService } from '../services/api';

export type BlockReason = 'membership' | 'background' | 'transport' | null;

/** hooks/useAccessGates-style membership rule for caregivers: active / trialing, or legacy membershipPaid with no status. */
export function caregiverMembershipActive(p: any): boolean {
  // Stripe's retry state (past_due / payment_failed) still counts as active (founder, 2026-10-06: no lock while Stripe is retrying — the lock lands when Stripe gives up and cancels); canceled / unpaid / inactive do not. Same rule in utils/caregiverEligibility.ts, agents/caregiverAccessGate.ts and firestore.rules.
  const s = p?.membershipStatus;
  return s === 'active' || s === 'trialing' || s === 'past_due' || s === 'payment_failed' || (!s && p?.membershipPaid === true);
}

/**
 * The Jobs page gate as a pure function of a caregiver record — the same rule
 * firestore.rules enforces on the application write and Evia's
 * caregiverAccessGate.ts runs before its own write. `transport` = the job
 * includes driving; then Transportation live on the record (offered + driving
 * record cleared, no documents since 2026-10-06) is required from WHOEVER
 * applies (2026-09-27).
 */
export function caregiverBlockReasonFor(p: any, transport: boolean): BlockReason {
  if (!caregiverMembershipActive(p)) return 'membership';
  const bgApprovedFull = p?.verified === true || p?.backgroundCheckStatus === 'clear' || p?.backgroundCheckComplete === true;
  if (!bgApprovedFull) return 'background';
  if (transport && !hasValidTransportDocs(p)) return 'transport';
  return null;
}

const REASON_CONFIG = {
  membership: {
    title: 'Membership required',
    desc: 'You need an active membership to take this action. Activate your membership to continue.',
    cta: 'Activate membership',
    path: '/caregiver/membership',
  },
  background: {
    title: 'Background check required',
    desc: 'Your background check must be cleared before you can take this action.',
    cta: 'Go to dashboard',
    path: '/caregiver/dashboard',
  },
  // 2026-10-06: Transportation = offered on the profile AND the driving record
  // cleared — no documents (founder: only the background check and the MVR).
  // Same line on the Jobs buttons and in Evia's text
  // (functions/src/agents/caregiverAccessGate.ts caregiverGateText).
  transport: {
    title: 'Set Up Transportation',
    // Founder, 2026-10-04: states the requirement, never an approval — Evia does not vouch for a driver.
    desc: "This job includes driving. To apply, offer Transportation on your profile and complete the driving record check, included in your membership. See where you stand under Settings › Membership & verification.",
    cta: 'Go to Settings',
    path: '/caregiver/settings',
  },
};

function CaregiverGateModal({
  reason,
  onClose,
}: {
  reason: BlockReason;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { setMembershipModalOpen, caregiverProfile } = useCareConnex();
  if (!reason) return null;
  const base = REASON_CONFIG[reason];
  // Transport: the next step depends on the record (2026-10-06). Not offering Transportation yet →
  // the only thing to do is add the service, so the button opens the Care Services editor.
  // Already offered → nothing to do but wait or read the result, so Settings shows where it stands.
  const needsService = reason === 'transport' && !offersTransportation(caregiverProfile as any);
  const { title, desc, cta, path } = needsService
    ? { ...base, cta: 'Add Transportation to my services', path: transportSetupPath(caregiverProfile) }
    : base;

  const handleCta = () => {
    onClose();
    if (reason === 'membership') {
      setMembershipModalOpen(true);
    } else {
      navigate(path);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-5 h-5 text-amber-500" />
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <h2 className="text-lg font-bold text-slate-900 mb-2">{title}</h2>
        <p className="text-sm text-slate-500 leading-relaxed mb-6">{desc}</p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-slate-200 text-slate-600 text-sm font-medium rounded-full hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCta}
            className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-full flex items-center justify-center gap-1.5 transition-colors"
          >
            {cta} <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function useCaregiverGate() {
  const { caregiverProfile, currentUser, refreshCaregiverProfile } = useCareConnex();
  const [showModal, setShowModal] = useState(false);
  const [activeReason, setActiveReason] = useState<BlockReason>(null);

  const p = caregiverProfile as any;
  const membershipActive = caregiverMembershipActive(p);
  // transport=false can never yield 'transport' — narrow so pages whose prop type predates the transport reason still typecheck.
  const blockReason = caregiverBlockReasonFor(p, false) as Exclude<BlockReason, 'transport'>;
  const transportBlockReason: BlockReason = caregiverBlockReasonFor(p, true);

  const canAct = blockReason === null;
  const canActTransport = transportBlockReason === null;
  /** The job-card "Set Up Transportation" button's destination (same rule as the popup). */
  const setUpTransportationPath = transportSetupPath(p);

  const gate = useCallback((onPass?: () => void): boolean => {
    if (canAct) { onPass?.(); return true; }
    setActiveReason(blockReason);
    setShowModal(true);
    return false;
  }, [canAct, blockReason]);

  const gateTransport = useCallback((onPass?: () => void): boolean => {
    if (canActTransport) { onPass?.(); return true; }
    setActiveReason(transportBlockReason);
    setShowModal(true);
    return false;
  }, [canActTransport, transportBlockReason]);

  // Re-reads the record before acting (2026-10-04). Founder live test: the admin
  // revoked a transportation badge and Apply Now stayed live in the caregiver's
  // open tab until a page refresh — the live profile listener had not delivered
  // the change to that tab. One fresh read at the click makes the decision
  // independent of the listener (the same read the login does), and pushes the
  // fresh record into context so the card buttons catch up. Falls back to the
  // live profile if the read fails. The write itself is gated again by
  // firestore.rules, so this is the courteous layer, not the only one.
  const gateFresh = useCallback(async (opts: { transport?: boolean } = {}, onPass?: () => void): Promise<boolean> => {
    let latest: any = caregiverProfile;
    const uid = currentUser?.uid;
    if (uid) {
      try {
        const fresh = await dbService.getUser(uid);
        if (fresh) latest = fresh;
      } catch { /* offline or denied — decide on the live profile */ }
    }
    const reason = caregiverBlockReasonFor(latest, !!opts.transport);
    if (!reason) { onPass?.(); return true; }
    setActiveReason(reason);
    setShowModal(true);
    void refreshCaregiverProfile().catch(() => {});
    return false;
  }, [caregiverProfile, currentUser?.uid, refreshCaregiverProfile]);

  // Membership-only gate — for lower-stakes actions like messaging
  const gateMembership = useCallback((onPass?: () => void): boolean => {
    if (membershipActive) { onPass?.(); return true; }
    setActiveReason('membership');
    setShowModal(true);
    return false;
  }, [membershipActive]);

  const GateModal = showModal ? (
    <CaregiverGateModal
      reason={activeReason}
      onClose={() => setShowModal(false)}
    />
  ) : null;

  return {
    setUpTransportationPath, gate, gateTransport, gateFresh, gateMembership, membershipActive, canAct, canActTransport, blockReason, transportBlockReason, GateModal };
}
