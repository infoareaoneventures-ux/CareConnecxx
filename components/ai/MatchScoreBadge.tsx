import React from 'react';
import { Sparkles, Award, Heart } from 'lucide-react';
import { MatchScore } from '../../types';

interface MatchScoreBadgeProps {
  score: MatchScore;
  size?: 'sm' | 'md' | 'lg';
  showDetails?: boolean;
}

/**
 * Get color theme based on score value
 * Uses CSS variables for consistent theming
 */
const getScoreColorTheme = (s: number) => {
  if (s >= 90) return { 
    bg: 'bg-[var(--color-emerald-500)]', 
    text: 'text-[var(--color-emerald-600)]', 
    light: 'bg-[var(--color-emerald-50)]', 
    border: 'border-[var(--color-emerald-200)]' 
  };
  if (s >= 80) return { 
    bg: 'bg-[var(--color-primary-500)]', 
    text: 'text-[var(--color-primary-600)]', 
    light: 'bg-[var(--color-primary-50)]', 
    border: 'border-[var(--color-primary-200)]' 
  };
  if (s >= 70) return { 
    bg: 'bg-[var(--color-info-500)]', 
    text: 'text-[var(--color-info-600)]', 
    light: 'bg-[var(--color-info-50)]', 
    border: 'border-[var(--color-info-200)]' 
  };
  if (s >= 60) return { 
    bg: 'bg-[var(--color-warning-500)]', 
    text: 'text-[var(--color-warning-600)]', 
    light: 'bg-[var(--color-warning-50)]', 
    border: 'border-[var(--color-warning-200)]' 
  };
  return { 
    bg: 'bg-[var(--color-neutral-400)]', 
    text: 'text-[var(--color-neutral-600)]', 
    light: 'bg-[var(--color-neutral-50)]', 
    border: 'border-[var(--color-neutral-200)]' 
  };
};

/**
 * Match Score Badge
 * Displays AI matching score with visual indicator
 */
export const MatchScoreBadge: React.FC<MatchScoreBadgeProps> = ({
  score,
  size = 'md',
  showDetails = false
}) => {
  const { overallScore, reasoning, confidence } = score;

  const colors = getScoreColorTheme(overallScore);

  const sizes = {
    sm: { badge: 'px-2 py-1 text-xs', icon: 'w-3 h-3', sparkles: 'w-3 h-3' },
    md: { badge: 'px-3 py-1.5 text-sm', icon: 'w-4 h-4', sparkles: 'w-4 h-4' },
    lg: { badge: 'px-4 py-2 text-base', icon: 'w-5 h-5', sparkles: 'w-5 h-5' }
  };

  const s = sizes[size];

  return (
    <div className="relative">
      {/* Main Badge */}
      <div className={`inline-flex items-center gap-1.5 ${s.badge} rounded-full ${colors.light} border ${colors.border} ${colors.text} font-bold`}>
        <Sparkles className={`${s.sparkles} ${overallScore >= 80 ? 'animate-pulse' : ''}`} />
        <span>{overallScore}% Match</span>
        {confidence === 'high' && <Award className={`${s.icon} text-[var(--color-warning-500)]`} />}
      </div>

      {/* Details Tooltip */}
      {showDetails && (
        <div className="absolute top-full left-0 mt-2 w-64 bg-white rounded-xl shadow-xl border border-[var(--color-neutral-200)] p-4 z-50 animate-fade-in">
          <h4 className="font-bold text-[var(--color-neutral-900)] mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[var(--color-primary-500)]" />
            Why this match?
          </h4>

          {/* Score Breakdown */}
          <div className="space-y-2 mb-4">
            <ScoreBar label="Skills Match" score={score.breakdown.skillsMatch} color="bg-[var(--color-emerald-500)]" />
            <ScoreBar label="Availability" score={score.breakdown.availabilityMatch} color="bg-[var(--color-info-500)]" />
            <ScoreBar label="Personality" score={score.breakdown.personalityMatch} color="bg-[var(--color-blue-500)]" />
            <ScoreBar label="Distance" score={score.breakdown.distanceScore} color="bg-[var(--color-accent-500)]" />
            <ScoreBar label="Rating" score={score.breakdown.ratingScore} color="bg-[var(--color-warning-500)]" />
          </div>

          {/* Reasoning */}
          <div className="border-t border-[var(--color-neutral-100)] pt-3">
            <p className="text-xs text-[var(--color-neutral-500)] mb-2">Key factors:</p>
            <ul className="space-y-1">
              {reasoning.map((reason, idx) => (
                <li key={idx} className="flex items-start gap-2 text-sm text-[var(--color-neutral-700)]">
                  <Heart className="w-4 h-4 text-[var(--color-primary-500)] mt-0.5 flex-shrink-0" />
                  {reason}
                </li>
              ))}
            </ul>
          </div>

          {/* Confidence */}
          <div className="mt-3 pt-3 border-t border-[var(--color-neutral-100)]">
            <span className={`text-xs px-2 py-1 rounded-full ${
              confidence === 'high' ? 'bg-[var(--color-emerald-100)] text-[var(--color-emerald-700)]' :
              confidence === 'medium' ? 'bg-[var(--color-warning-100)] text-[var(--color-warning-700)]' :
              'bg-[var(--color-neutral-100)] text-[var(--color-neutral-600)]'
            }`}>
              {confidence === 'high' ? 'High Confidence' : confidence === 'medium' ? 'Medium Confidence' : 'Learning...'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Individual score bar
 */
const ScoreBar: React.FC<{ label: string; score: number; color: string }> = ({ label, score, color }) => (
  <div className="flex items-center gap-2">
    <span className="text-xs text-[var(--color-neutral-500)] w-20">{label}</span>
    <div className="flex-1 h-2 bg-[var(--color-neutral-100)] rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${score}%` }} />
    </div>
    <span className="text-xs font-bold text-[var(--color-neutral-700)] w-8 text-right">{score}</span>
  </div>
);

/**
 * Compact match indicator for caregiver cards
 */
export const MatchIndicator: React.FC<{ score: number }> = ({ score }) => {
  const getColor = () => {
    if (score >= 90) return 'bg-[var(--color-emerald-500)]';
    if (score >= 80) return 'bg-[var(--color-primary-500)]';
    if (score >= 70) return 'bg-[var(--color-info-500)]';
    if (score >= 60) return 'bg-[var(--color-warning-500)]';
    return 'bg-[var(--color-neutral-400)]';
  };

  const getTextColor = () => {
    if (score >= 80) return 'text-[var(--color-emerald-600)]';
    if (score >= 70) return 'text-[var(--color-info-600)]';
    if (score >= 60) return 'text-[var(--color-warning-600)]';
    return 'text-[var(--color-neutral-500)]';
  };

  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2 h-2 rounded-full ${getColor()} ${score >= 80 ? 'animate-pulse' : ''}`} />
      <span className={`text-sm font-bold ${getTextColor()}`}>
        {score}%
      </span>
    </div>
  );
};
