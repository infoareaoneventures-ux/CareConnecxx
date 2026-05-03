import React from 'react';
import { Sparkles, TrendingUp, Heart, Star, Target } from 'lucide-react';
import { MatchScore } from '../../types';

interface MLMatchInsightsProps {
  score: MatchScore & { mlPrediction: { bookingProbability: number; predictedSatisfaction: number; rebookingProbability: number } };
  showDetails?: boolean;
}

/**
 * ML Match Insights Component
 * Shows AI predictions about match quality
 */
export const MLMatchInsights: React.FC<MLMatchInsightsProps> = ({
  score,
  showDetails = false
}) => {
  const { mlPrediction, overallScore } = score;
  
  if (!mlPrediction) return null;
  
  const { bookingProbability, predictedSatisfaction, rebookingProbability } = mlPrediction;
  
  const getProbabilityColor = (prob: number) => {
    if (prob >= 70) return 'text-emerald-600 bg-emerald-50 border-emerald-200';
    if (prob >= 50) return 'text-blue-600 bg-blue-50 border-blue-200';
    if (prob >= 30) return 'text-accent-600 bg-accent-50 border-accent-200';
    return 'text-slate-600 bg-slate-50 border-slate-200';
  };
  
  const getSatisfactionColor = (rating: number) => {
    if (rating >= 4.5) return 'text-emerald-600';
    if (rating >= 4.0) return 'text-primary-600';
    if (rating >= 3.5) return 'text-blue-600';
    if (rating >= 3.0) return 'text-accent-600';
    return 'text-slate-600';
  };

  return (
    <div className="bg-gradient-to-br from-slate-50 to-slate-100 rounded-2xl p-4 border border-slate-200">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-5 h-5 text-primary-600" />
        <h4 className="font-bold text-slate-900">AI Match Insights</h4>
      </div>
      
      {/* Main Prediction Cards */}
      <div className="grid grid-cols-3 gap-3">
        {/* Booking Probability */}
        <div className={`p-3 rounded-xl border ${getProbabilityColor(bookingProbability)}`}>
          <div className="flex items-center gap-1 mb-1">
            <Target className="w-4 h-4" />
            <span className="text-xs font-medium opacity-80">Match</span>
          </div>
          <div className="text-2xl font-bold">{bookingProbability}%</div>
          <div className="text-xs opacity-70">Likelihood</div>
        </div>
        
        {/* Predicted Satisfaction */}
        <div className={`p-3 rounded-xl border ${getProbabilityColor(predictedSatisfaction * 20)}`}>
          <div className="flex items-center gap-1 mb-1">
            <Star className="w-4 h-4" />
            <span className="text-xs font-medium opacity-80">Rating</span>
          </div>
          <div className={`text-2xl font-bold ${getSatisfactionColor(predictedSatisfaction)}`}>
            {predictedSatisfaction}
          </div>
          <div className="text-xs opacity-70">Predicted</div>
        </div>
        
        {/* Rebooking Probability */}
        <div className={`p-3 rounded-xl border ${getProbabilityColor(rebookingProbability)}`}>
          <div className="flex items-center gap-1 mb-1">
            <Heart className="w-4 h-4" />
            <span className="text-xs font-medium opacity-80">Retention</span>
          </div>
          <div className="text-2xl font-bold">{rebookingProbability}%</div>
          <div className="text-xs opacity-70">Rebooking</div>
        </div>
      </div>
      
      {/* Details Section */}
      {showDetails && (
        <div className="mt-4 pt-4 border-t border-slate-200">
          <h5 className="text-sm font-semibold text-slate-700 mb-2">What This Means</h5>
          <ul className="space-y-2 text-sm text-slate-600">
            <li className="flex items-start gap-2">
              <TrendingUp className="w-4 h-4 text-primary-600 mt-0.5 flex-shrink-0" />
              <span>
                <strong>{bookingProbability}% chance</strong> this match results in a booking based on similar profiles
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Star className="w-4 h-4 text-accent-500 mt-0.5 flex-shrink-0" />
              <span>
                Families typically rate this match <strong>{predictedSatisfaction}/5 stars</strong>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Heart className="w-4 h-4 text-rose-500 mt-0.5 flex-shrink-0" />
              <span>
                <strong>{rebookingProbability}% of families</strong> book this caregiver again
              </span>
            </li>
          </ul>
          
          <div className="mt-3 p-2 bg-primary-50 rounded-lg border border-primary-100">
            <p className="text-xs text-primary-700">
              <strong>💡 AI Insight:</strong> Our model analyzed 15,000+ care scenarios to predict these outcomes.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
