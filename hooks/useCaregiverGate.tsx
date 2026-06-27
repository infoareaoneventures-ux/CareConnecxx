import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, X } from 'lucide-react';
import { useCareConnex } from '../context/CareConnexContext';
import { hasValidTransportDocs } from '../utils/transportDocs';

type BlockReason = 'membership' | 'background' | 'transport' | null;

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
  transport: {
    title: 'Transport documents required',
    desc: 'Your transportation documents must be approved before you can apply to transport jobs.',
    cta: 'Upload documents',
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
  const { setMembershipModalOpen } = useCareConnex();
  if (!reason) return null;
  const { title, desc, cta, path } = REASON_CONFIG[reason];

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
  const { caregiverProfile } = useCareConnex();
  const [showModal, setShowModal] = useState(false);
  const [activeReason, setActiveReason] = useState<BlockReason>(null);

  const p = caregiverProfile as any;
  const membershipActive = p?.membershipStatus === 'active' || p?.membershipStatus === 'trialing' || (!p?.membershipStatus && p?.membershipPaid === true);
  const bgApprovedFull = p?.verified === true || p?.backgroundCheckStatus === 'clear' || p?.backgroundCheckComplete === true;
  const services: string[] = (p?.services || p?.skills || []) as string[];
  const needsTransportDocs = services.includes('Transportation');
  const transportDocsValid = needsTransportDocs ? hasValidTransportDocs(caregiverProfile as any) : true;

  const blockReason: BlockReason = !membershipActive ? 'membership' : !bgApprovedFull ? 'background' : null;
  const transportBlockReason: BlockReason = !membershipActive ? 'membership' : !bgApprovedFull ? 'background' : !transportDocsValid ? 'transport' : null;

  const canAct = blockReason === null;
  const canActTransport = transportBlockReason === null;

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

  return { gate, gateTransport, gateMembership, membershipActive, canAct, canActTransport, blockReason, transportBlockReason, GateModal };
}
