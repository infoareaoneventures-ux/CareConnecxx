import React from 'react';
import { Shield } from 'lucide-react';
import { Caregiver } from '../../types';

interface TrustBadgeProps {
  caregiver: Caregiver;
  className?: string;
}

interface TrustResult {
  score: number;
  tier: 'elite' | 'trusted' | 'verified' | null;
  label: string | null;
  color: string;
  shieldColor: string;
}

export function computeTrustScore(caregiver: Caregiver): number {
  let score = 0;

  // Background check verified: 30 pts
  const bgClear =
    caregiver.backgroundCheckStatus === 'clear' ||
    caregiver.backgroundCheckData?.status === 'clear';
  if (bgClear) score += 30;

  // Tenure months (capped at 12): up to 20 pts
  if (caregiver.approvedAt) {
    const months = Math.floor(
      (Date.now() - new Date(caregiver.approvedAt).getTime()) / (30 * 24 * 60 * 60 * 1000)
    );
    score += Math.min(months, 12) / 12 * 20;
  }

  // Avg rating (0–5): up to 20 pts
  if (caregiver.rating != null) {
    score += (caregiver.rating / 5) * 20;
  }

  // Identity verified: 15 pts
  if (
    caregiver.verificationStatus === 'approved' ||
    caregiver.verificationStatus === 'checkr_clear'
  ) {
    score += 15;
  }

  // Certifications count (capped at 3): up to 15 pts
  const certCount = caregiver.certifications?.length ?? 0;
  score += (Math.min(certCount, 3) / 3) * 15;

  return Math.round(score);
}

function getTrustResult(score: number): TrustResult {
  if (score >= 90) {
    return { score, tier: 'elite', label: 'Elite', color: 'text-amber-700 bg-amber-50 border-amber-200', shieldColor: 'text-amber-500' };
  }
  if (score >= 75) {
    return { score, tier: 'trusted', label: 'Trusted', color: 'text-slate-700 bg-slate-100 border-slate-300', shieldColor: 'text-slate-400' };
  }
  if (score >= 60) {
    return { score, tier: 'verified', label: 'Verified', color: 'text-primary-700 bg-primary-50 border-primary-200', shieldColor: 'text-primary-500' };
  }
  return { score, tier: null, label: null, color: '', shieldColor: '' };
}

export const TrustBadge: React.FC<TrustBadgeProps> = ({ caregiver, className = '' }) => {
  const score = computeTrustScore(caregiver);
  const result = getTrustResult(score);

  if (!result.tier) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${result.color} ${className}`}
      title={`Trust Score: ${score}/100`}
    >
      <Shield className={`w-3 h-3 ${result.shieldColor}`} />
      {result.label} · {score}
    </span>
  );
};
