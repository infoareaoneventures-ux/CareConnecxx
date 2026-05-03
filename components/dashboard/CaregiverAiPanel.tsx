import React from 'react';
import { Sparkles, MessageSquare, TrendingUp, Target, Clock } from 'lucide-react';
import { SlideUp } from '../ui/Motion';
import { AddToastFunction, Caregiver } from '../../types';

interface CaregiverAiPanelProps {
  profile: Caregiver | null;
  onOpenChat: () => void;
  onViewEarnings: () => void;
  onShowToast: AddToastFunction;
}

export const CaregiverAiPanel: React.FC<CaregiverAiPanelProps> = ({
  profile,
  onOpenChat,
  onViewEarnings,
  onShowToast
}) => {
  // Calculate AI insights
  const getRateInsight = () => {
    if (!profile) return null;
    
    const marketAvg = 28;
    const myRate = profile.hourlyRate;
    
    if (myRate < marketAvg - 3) {
      return {
        type: 'opportunity',
        message: `Your rate is $${marketAvg - myRate} below market average. Consider raising to $${Math.round(marketAvg)}.`,
        action: 'Adjust Rate'
      };
    } else if (myRate > marketAvg + 5) {
      return {
        type: 'premium',
        message: `Your premium rate is competitive! Highlight your certifications to justify $${myRate}/hr.`,
        action: 'View Profile'
      };
    }
    return {
      type: 'balanced',
      message: 'Your rate is well-positioned in the market.',
      action: null
    };
  };

  const rateInsight = getRateInsight();
  const completedJobs = profile?.completedJobs || 0;
  const earnings = profile?.totalEarnings || 0;

  return (
    <SlideUp>
      <div className="bg-gradient-to-br from-accent-500 via-orange-400 to-accent-500 rounded-3xl p-6 text-white shadow-xl mb-6 relative overflow-hidden">
        {/* Decorative Background */}
        <div className="absolute top-0 right-0 w-48 h-48 bg-white/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/5 rounded-full blur-2xl"></div>

        <div className="relative z-10">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="bg-white/20 p-2 rounded-xl">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold">AI Insights</h2>
                <p className="text-accent-100 text-sm">Personalized for you</p>
              </div>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">{completedJobs}</div>
              <div className="text-xs text-accent-100">Jobs Done</div>
            </div>
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">${earnings}</div>
              <div className="text-xs text-accent-100">Earnings</div>
            </div>
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">{profile?.rating?.toFixed(1) || 'New'}</div>
              <div className="text-xs text-accent-100">Rating</div>
            </div>
          </div>

          {/* Rate Insight */}
          {rateInsight && (
            <div className="bg-white/20 backdrop-blur-sm rounded-xl p-4 mb-4">
              <div className="flex items-start gap-3">
                <TrendingUp className="w-5 h-5 text-white flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-white leading-relaxed">
                    {rateInsight.message}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Quick Actions */}
          <div className="flex gap-3">
            <button
              onClick={onOpenChat}
              className="flex-1 bg-white/20 hover:bg-white/30 border border-white/30 text-white px-4 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all"
            >
              <MessageSquare className="w-4 h-4" />
              Messages
            </button>
            <button
              onClick={onViewEarnings}
              className="flex-1 bg-white text-accent-600 px-4 py-3 rounded-xl font-semibold text-sm hover:bg-accent-50 transition-all"
            >
              View Earnings
            </button>
          </div>
        </div>
      </div>
    </SlideUp>
  );
};
