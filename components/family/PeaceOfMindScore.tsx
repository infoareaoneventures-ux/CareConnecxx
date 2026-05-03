import React from 'react';
import { Heart, Shield, AlertTriangle, CheckCircle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { CareJournalEntry } from '../../types';

interface PeaceOfMindScoreProps {
  entries: CareJournalEntry[];
  seniorName: string;
  daysToAnalyze?: number;
}

interface WellnessTrend {
  direction: 'up' | 'down' | 'stable';
  score: number;
  label: string;
}

/**
 * Peace of Mind Score Component
 * Gives families an at-a-glance wellness indicator
 */
export const PeaceOfMindScore: React.FC<PeaceOfMindScoreProps> = ({
  entries,
  seniorName,
  daysToAnalyze = 7
}) => {
  // Calculate overall wellness score with error handling
  let analysis;
  try {
    analysis = analyzeWellness(entries, daysToAnalyze);
  } catch (error) {
    console.error('Failed to analyze wellness:', error);
    // Return default safe values
    analysis = {
      overallScore: 50,
      trend: { direction: 'stable' as const, score: 0, label: 'No data' },
      factors: [
        { label: 'Meals', score: 50 },
        { label: 'Medication', score: 50 },
        { label: 'Activity', score: 50 },
        { label: 'Mood', score: 50 }
      ],
      status: 'watch' as const
    };
  }
  const { overallScore, trend, factors, status } = analysis;

  const statusConfig = {
    excellent: {
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
      border: 'border-emerald-200',
      icon: Heart,
      label: 'Excellent',
      message: `${seniorName} is doing great! All wellness indicators are positive.`
    },
    good: {
      color: 'text-primary-600',
      bg: 'bg-primary-50',
      border: 'border-primary-200',
      icon: CheckCircle,
      label: 'Good',
      message: `${seniorName} is doing well with consistent care.`
    },
    watch: {
      color: 'text-accent-600',
      bg: 'bg-accent-50',
      border: 'border-accent-200',
      icon: Shield,
      label: 'Watch',
      message: `Some minor concerns. Consider checking in with ${seniorName}.`
    },
    concern: {
      color: 'text-red-600',
      bg: 'bg-red-50',
      border: 'border-red-200',
      icon: AlertTriangle,
      label: 'Needs Attention',
      message: `Multiple concerns detected. Please review care plan or contact caregiver.`
    }
  };

  const config = statusConfig[status];
  const StatusIcon = config.icon;
  const TrendIcon = trend.direction === 'up' ? TrendingUp : trend.direction === 'down' ? TrendingDown : Minus;

  return (
    <div className={`${config.bg} border-2 ${config.border} rounded-3xl p-6`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-slate-700 mb-1">Peace of Mind Score</h3>
          <p className="text-sm text-slate-500">Last {daysToAnalyze} days</p>
        </div>
        <div className={`${config.bg} p-3 rounded-2xl border-2 ${config.border}`}>
          <StatusIcon className={`w-8 h-8 ${config.color}`} />
        </div>
      </div>

      {/* Score Display */}
      <div className="flex items-end gap-4 mb-6">
        <div className={`text-6xl font-bold ${config.color}`}>
          {overallScore}
        </div>
        <div className="pb-3">
          <span className={`text-lg font-bold ${config.color}`}>/100</span>
          <div className={`flex items-center gap-1 mt-1 ${
            trend.direction === 'up' ? 'text-emerald-600' :
            trend.direction === 'down' ? 'text-red-600' :
            'text-slate-500'
          }`}>
            <TrendIcon className="w-4 h-4" />
            <span className="text-sm font-medium">{trend.label}</span>
          </div>
        </div>
      </div>

      {/* Status Badge */}
      <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full ${config.bg} border ${config.border} mb-4`}>
        <span className={`font-bold ${config.color}`}>{config.label}</span>
      </div>

      {/* Message */}
      <p className="text-slate-700 mb-6">{config.message}</p>

      {/* Factor Breakdown */}
      <div className="grid grid-cols-2 gap-3">
        {factors.map((factor, idx) => (
          <div key={idx} className="bg-white rounded-xl p-3 border border-slate-200">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-slate-600">{factor.label}</span>
              <span className={`text-sm font-bold ${
                factor.score >= 80 ? 'text-emerald-600' :
                factor.score >= 60 ? 'text-primary-600' :
                factor.score >= 40 ? 'text-accent-600' :
                'text-red-600'
              }`}>
                {factor.score}%
              </span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full ${
                  factor.score >= 80 ? 'bg-emerald-500' :
                  factor.score >= 60 ? 'bg-primary-500' :
                  factor.score >= 40 ? 'bg-accent-500' :
                  'bg-red-500'
                }`}
                style={{ width: `${factor.score}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Analyze wellness data and generate score
 */
function analyzeWellness(
  entries: CareJournalEntry[],
  daysToAnalyze: number
): {
  overallScore: number;
  trend: WellnessTrend;
  factors: { label: string; score: number }[];
  status: 'excellent' | 'good' | 'watch' | 'concern';
} {
  // Filter to recent entries
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToAnalyze);
  
  const recentEntries = entries.filter(e => 
    new Date(e.timestamp) >= cutoffDate
  );

  if (recentEntries.length === 0) {
    return {
      overallScore: 50,
      trend: { direction: 'stable', score: 50, label: 'No recent data' },
      factors: [
        { label: 'Meals', score: 50 },
        { label: 'Medication', score: 50 },
        { label: 'Activity', score: 50 },
        { label: 'Mood', score: 50 }
      ],
      status: 'watch'
    };
  }

  // Calculate factor scores
  const totalVisits = recentEntries.length;
  
  const mealsScore = Math.round(
    (recentEntries.filter(e => e.wellness?.ateWell).length / totalVisits) * 100
  );
  
  const medsScore = Math.round(
    (recentEntries.filter(e => e.wellness?.tookMeds).length / totalVisits) * 100
  );
  
  const activityScore = Math.round(
    (recentEntries.filter(e => e.wellness?.wasActive).length / totalVisits) * 100
  );
  
  const moodScore = calculateMoodScore(recentEntries);

  // Calculate overall score (weighted)
  const overallScore = Math.round(
    mealsScore * 0.25 +
    medsScore * 0.30 +
    activityScore * 0.20 +
    moodScore * 0.25
  );

  // Determine trend (compare first half to second half)
  const midpoint = Math.floor(recentEntries.length / 2);
  const firstHalf = recentEntries.slice(0, midpoint);
  const secondHalf = recentEntries.slice(midpoint);
  
  const firstHalfScore = calculatePeriodScore(firstHalf);
  const secondHalfScore = calculatePeriodScore(secondHalf);
  
  const scoreChange = secondHalfScore - firstHalfScore;
  const trend: WellnessTrend = {
    direction: scoreChange > 5 ? 'up' : scoreChange < -5 ? 'down' : 'stable',
    score: Math.abs(scoreChange),
    label: scoreChange > 5 ? 'Improving' : scoreChange < -5 ? 'Declining' : 'Stable'
  };

  // Determine status
  const status = overallScore >= 90 ? 'excellent' :
                 overallScore >= 75 ? 'good' :
                 overallScore >= 50 ? 'watch' :
                 'concern';

  return {
    overallScore,
    trend,
    factors: [
      { label: 'Meals', score: mealsScore },
      { label: 'Medication', score: medsScore },
      { label: 'Activity', score: activityScore },
      { label: 'Mood', score: moodScore }
    ],
    status
  };
}

/**
 * Calculate mood score from entries
 */
function calculateMoodScore(entries: CareJournalEntry[]): number {
  if (entries.length === 0) return 50;

  const moodValues: Record<string, number> = {
    'great': 100,
    'good': 80,
    'ok': 50,
    'poor': 20
  };

  const total = entries.reduce((sum, entry) => {
    const mood = entry.wellness?.mood || 'ok';
    return sum + (moodValues[mood] || 50);
  }, 0);

  return Math.round(total / entries.length);
}

/**
 * Calculate score for a time period
 */
function calculatePeriodScore(entries: CareJournalEntry[]): number {
  if (entries.length === 0) return 50;

  const scores = entries.map(e => {
    let score = 50;
    if (e.wellness?.ateWell) score += 12.5;
    if (e.wellness?.tookMeds) score += 12.5;
    if (e.wellness?.wasActive) score += 12.5;
    const moodScores: Record<string, number> = { 'great': 12.5, 'good': 10, 'ok': 5, 'poor': 0 };
    score += moodScores[e.wellness?.mood || 'ok'] || 5;
    return score;
  });

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
