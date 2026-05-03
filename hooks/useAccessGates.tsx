import React, { useCallback, useEffect, useState } from 'react';
import { auth, db } from '../lib/firebase';
import { startIdentityVerification } from '../services/stripeService';
import { IdentityGateModal } from '../components/client/IdentityGateModal';
import { PlanSelectModal } from '../components/client/PlanSelectModal';

export type GateAction = 'message' | 'interview' | 'booking';

type PendingGate = {
  action: GateAction;
  caregiverName?: string;
  onPass: () => void;
} | null;

/**
 * Central gate for paywalled/verification-gated client actions.
 *
 * Returns:
 *  - `ready`: identity + membership status have been loaded.
 *  - `identityVerified` / `membershipActive`: current status.
 *  - `gate(action, caregiverName, onPass)`: runs `onPass()` immediately if both
 *    gates pass; otherwise opens the appropriate modal and holds `onPass` for
 *    retry after the user completes the step that was missing.
 *  - `Modals`: render this component once at the page root so the gate modals
 *    have somewhere to mount.
 */
export function useAccessGates() {
  const [identityStatus, setIdentityStatus] = useState<string>('not_started');
  const [membershipActive, setMembershipActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PendingGate>(null);

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) { setReady(true); return; }

    const unsub = db.collection('users').doc(uid).onSnapshot(doc => {
      const data = (doc.data() as any) || {};
      setIdentityStatus(data.identityCheckStatus || 'not_started');
      setMembershipActive(!!data.subscriptionActive || data.membershipStatus === 'active' || data.membershipStatus === 'trialing');
      setReady(true);
    }, () => setReady(true));

    return () => unsub();
  }, []);

  const identityVerified = identityStatus === 'verified';

  const gate = useCallback((action: GateAction, caregiverName: string | undefined, onPass: () => void) => {
    if (!identityVerified) {
      setPending({ action, caregiverName, onPass });
      return;
    }
    if (!membershipActive) {
      setPending({ action, caregiverName, onPass });
      return;
    }
    onPass();
  }, [identityVerified, membershipActive]);

  const dismiss = () => setPending(null);

  const handleGetVerified = async () => {
    const next = window.location.pathname + window.location.search;
    const returnUrl = `${window.location.origin}/client/identity-callback?next=${encodeURIComponent(next)}`;
    try {
      await startIdentityVerification(returnUrl);
    } catch (e) {
      console.error('Failed to start identity verification', e);
      alert('Could not start identity verification. Please try again.');
    }
  };

  const Modals: React.FC = () => {
    if (!pending) return null;

    if (!identityVerified) {
      return (
        <IdentityGateModal
          caregiverName={pending.caregiverName}
          onClose={dismiss}
          onGetVerified={handleGetVerified}
        />
      );
    }

    if (!membershipActive) {
      return (
        <PlanSelectModal
          onClose={dismiss}
          caregiverName={pending.caregiverName}
          context={pending.action}
        />
      );
    }

    return null;
  };

  return { ready, identityStatus, identityVerified, membershipActive, gate, Modals };
}
