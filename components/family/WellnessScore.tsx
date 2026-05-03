import React, { useState, useMemo } from 'react';
import { 
  Heart, 
  TrendingUp, 
  TrendingDown, 
  Minus, 
  Activity, 
  Pill, 
  Sun,
  Moon,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Info
} from 'lucide-react';
import { CareJournalEntry } from '../../types';

interface WellnessScoreProps {
  entries: CareJournalEntry[];
  seniorName: string;
  daysToAnalyze?: number;
}

interface DailyScore {
  date: string;
  score: number;
  activity: number;
  mood: number;
  medication: number;
  social: number;
}

interface WellnessTrend {
  direction: 'improving' | 'declining' | 'stable';
  change: number;
}

/**
 * AI-Generated Wellness Score Component
 * Calculates wellness metric based on activity, mood, and medication adherence
 * Shows weekly trend visualization
 */
export const WellnessScore: React.FC<WellnessScoreProps> = ({
  entries,
  seniorName,
  daysToAnalyze = 7
}) => {
  const [selectedWeek, setSelectedWeek] = useState(0);
  const [showDetails, setShowDetails] = useState(false);

  // Calculate wellness scores
  const { currentScore, weeklyScores, trend, factors } = useMemo(() => {
    if (entries.length === 0) {
      return {
        currentScore: 50,
        weeklyScores: [],
        trend: { direction: 'stable' as const, change: 0 },
        factors: [
          { label: 'Physical Activity', score: 50, icon: Activity },
          { label: 'Mood & Wellbeing', score: 50, icon: Sun },
          { label: 'Medication', score: 50, icon: Pill },
          { label: 'Social Engagement', score: 50, icon: Heart }
        ]
      };
    }

    // Group entries by date
    const entriesByDate = new Map<string, CareJournalEntry[]>();
    
    entries.forEach(entry => {
      const date = new Date(entry.timestamp).toISOString().split('T')[0];
      if (!entriesByDate.has(date)) {
        entriesByDate.set(date, []);
      }
      entriesByDate.get(date)!.push(entry);
    });

    // Calculate daily scores
    const dailyScores: DailyScore[] = [];
    entriesByDate.forEach((dayEntries, date) => {
      let activity = 0, mood = 0, medication = 0, social = 0;
      
      dayEntries.forEach(entry => {
        if (entry.wellness?.wasActive) activity += 25;
        if (entry.wellness?.tookMeds) medication += 25;
        
        const moodScores: Record<string, number> = { 'great': 25, 'good': 20, 'ok': 12, 'poor': 5 };
        mood += moodScores[entry.wellness?.mood || 'ok'] || 12;
        
        if (entry.activities?.some(a => a.toLowerCase().includes('social') || a.toLowerCase().includes('visit'))) {
          social += 25;
        }
      });

      const count = dayEntries.length;
      dailyScores.push({
        date,
        score: Math.round((activity + mood + medication + social) / count),
        activity: Math.min(100, Math.round(activity / count)),
        mood: Math.min(100, Math.round(mood / count)),
        medication: Math.min(100, Math.round(medication / count)),
        social: Math.min(100, Math.round(social / count))
      });
    });

    // Sort by date
    dailyScores.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Get recent scores for trend
    const recentScores = dailyScores.slice(-daysToAnalyze);
    const currentScore = recentScores.length > 0 
      ? Math.round(recentScores.reduce((sum, d) => sum + d.score, 0) / recentScores.length)
      : 50;

    // Calculate trend
    const firstHalf = recentScores.slice(0, Math.floor(recentScores.length / 2));
    const secondHalf = recentScores.slice(Math.floor(recentScores.length / 2));
    const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((s, d) => s + d.score, 0) / firstHalf.length : currentScore;
    const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((s, d) => s + d.score, 0) / secondHalf.length : currentScore;
    const change = secondAvg - firstAvg;
    
    const trend: WellnessTrend = {
      direction: change > 5 ? 'improving' : change < -5 ? 'declining' : 'stable',
      change: Math.abs(Math.round(change))
    };

    // Calculate factor averages
    const factorAverages = recentScores.length > 0 ? {
      activity: Math.round(recentScores.reduce((s, d) => s + d.activity, 0) / recentScores.length),
      mood: Math.round(recentScores.reduce((s, d) => s + d.mood, 0) / recentScores.length),
      medication: Math.round(recentScores.reduce((s, d) => s + d.medication, 0) / recentScores.length),
      social: Math.round(recentScores.reduce((s, d) => s + d.social, 0) / recentScores.length)
    } : { activity: 50, mood: 50, medication: 50, social: 50 };

    const factors = [
      { label: 'Physical Activity', score: factorAverages.activity, icon: Activity },
      { label: 'Mood & Wellbeing', score: factorAverages.mood, icon: Sun },
      { label: 'Medication', score: factorAverages.medication, icon: Pill },
      { label: 'Social Engagement', score: factorAverages.social, icon: Heart }
    ];

    return { currentScore, weeklyScores: dailyScores.slice(-14), trend, factors };
  }, [entries, daysToAnalyze]);

  // Get status color and message
  const getStatus = (score: number) => {
    if (score >= 80) return { 
      color: 'text-emerald-600', 
      bg: 'bg-emerald-50', 
      border: 'border-emerald-200',
      gradient: 'from-emerald-500 to-primary-500',
      label: 'Excellent',
      message: `${seniorName} is thriving!` 
    };
    if (score >= 60) return { 
      color: 'text-primary-600', 
      bg: 'bg-primary-50', 
      border: 'border-primary-200',
      gradient: 'from-primary-500 to-cyan-500',
      label: 'Good',
      message: `${seniorName} is doing well` 
    };
    if (score >= 40) return { 
      color: 'text-accent-600', 
      bg: 'bg-accent-50', 
      border: 'border-accent-200',
      gradient: 'from-accent-500 to-accent-500',
      label: 'Fair',
      message: `Some areas need attention` 
    };
    return { 
      color: 'text-red-600', 
      bg: 'bg-red-50', 
      border: 'border-red-200',
      gradient: 'from-red-500 to-rose-500',
      label: 'Needs Attention',
      message: `Please review care plan` 
    };
  };

  const status = getStatus(currentScore);

  // Generate chart data (last 7 days)
  const chartData = weeklyScores.slice(-7);
  const maxScore = 100;
  const chartHeight = 120;

  return (
    <div className={`${status.bg} border-2 ${status.border} rounded-3xl p-6`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`bg-gradient-to-br ${status.gradient} p-3 rounded-2xl shadow-lg`}>
            <Heart className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900">Wellness Score</h3>
            <p className="text-sm text-slate-500">AI-powered health metric</p>
          </div>
        </div>
        <button 
          onClick={() => setShowDetails(!showDetails)}
          className="p-2 hover:bg-white/50 rounded-xl transition-colors"
        >
          <Info className="w-5 h-5 text-slate-400" />
        </button>
      </div>

      {/* Main Score */}
      <div className="flex items-end gap-4 mb-4">
        <div className={`text-6xl font-bold ${status.color}`}>
          {currentScore}
        </div>
        <div className="pb-3">
          <span className="text-lg font-bold text-slate-400">/100</span>
          <div className={`flex items-center gap-1 mt-1 ${
            trend.direction === 'improving' ? 'text-emerald-600' :
            trend.direction === 'declining' ? 'text-red-600' :
            'text-slate-500'
          }`}>
            {trend.direction === 'improving' ? <TrendingUp className="w-4 h-4" /> :
             trend.direction === 'declining' ? <TrendingDown className="w-4 h-4" /> :
             <Minus className="w-4 h-4" />}
            <span className="text-sm font-medium">
              {trend.direction === 'improving' ? '+' : trend.direction === 'declining' ? '-' : ''}
              {trend.change}% this week
            </span>
          </div>
        </div>
      </div>

      {/* Status Badge */}
      <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full ${status.bg} border ${status.border} mb-4`}>
        <Sparkles className={`w-4 h-4 ${status.color}`} />
        <span className={`font-bold ${status.color}`}>{status.label}</span>
      </div>

      {/* Message */}
      <p className="text-slate-700 mb-6">{status.message}</p>

      {/* Weekly Trend Chart */}
      <div className="bg-white rounded-2xl p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold text-slate-900 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            7-Day Trend
          </h4>
        </div>

        {/* Bar Chart */}
        <div className="relative h-32 flex items-end justify-between gap-2">
          {chartData.map((day, idx) => {
            const height = (day.score / maxScore) * chartHeight;
            const dayLabel = new Date(day.date).toLocaleDateString('en-US', { weekday: 'narrow' });
            const isToday = idx === chartData.length - 1;
            
            return (
              <div key={day.date} className="flex-1 flex flex-col items-center">
                <div className="relative w-full flex items-end justify-center" style={{ height: chartHeight }}>
                  <div
                    className={`w-full max-w-8 rounded-t-lg transition-all duration-500 ${
                      isToday 
                        ? `bg-gradient-to-t ${status.gradient}` 
                        : 'bg-slate-200'
                    }`}
                    style={{ height: `${height}px` }}
                  />
                  {/* Tooltip on hover */}
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 opacity-0 hover:opacity-100 transition-opacity bg-slate-800 text-white text-xs px-2 py-1 rounded whitespace-nowrap z-10">
                    {day.score}
                  </div>
                </div>
                <span className={`text-xs mt-2 ${isToday ? 'font-bold text-slate-900' : 'text-slate-400'}`}>
                  {dayLabel}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Factor Breakdown */}
      <div className="grid grid-cols-2 gap-3">
        {factors.map((factor, idx) => {
          const Icon = factor.icon;
          return (
            <div key={idx} className="bg-white rounded-xl p-3 border border-slate-100">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon className={`w-4 h-4 ${
                    factor.score >= 80 ? 'text-emerald-500' :
                    factor.score >= 60 ? 'text-primary-500' :
                    factor.score >= 40 ? 'text-accent-500' :
                    'text-red-500'
                  }`} />
                  <span className="text-sm text-slate-600">{factor.label}</span>
                </div>
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
                  className={`h-full rounded-full transition-all duration-500 ${
                    factor.score >= 80 ? 'bg-emerald-500' :
                    factor.score >= 60 ? 'bg-primary-500' :
                    factor.score >= 40 ? 'bg-accent-500' :
                    'bg-red-500'
                  }`}
                  style={{ width: `${factor.score}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* AI Insight */}
      {showDetails && (
        <div className="mt-4 bg-white/50 rounded-xl p-4 border border-white">
          <h4 className="font-semibold text-slate-900 mb-2 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-500" />
            AI Insights
          </h4>
          <ul className="space-y-2 text-sm text-slate-600">
            {trend.direction === 'improving' && (
              <li className="flex items-start gap-2">
                <span className="text-emerald-500">↑</span>
                <span>Wellness trend is positive. Keep up the great care routine!</span>
              </li>
            )}
            {trend.direction === 'declining' && (
              <li className="flex items-start gap-2">
                <span className="text-red-500">↓</span>
                <span>Recent decline detected. Consider reviewing care activities.</span>
              </li>
            )}
            {factors.find(f => f.label === 'Medication')!.score < 70 && (
              <li className="flex items-start gap-2">
                <span className="text-accent-500">!</span>
                <span>Medication adherence is below target. Reminder system recommended.</span>
              </li>
            )}
            {factors.find(f => f.label === 'Physical Activity')!.score < 60 && (
              <li className="flex items-start gap-2">
                <span className="text-blue-500">→</span>
                <span>Consider increasing physical activities during care visits.</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

export default WellnessScore;
