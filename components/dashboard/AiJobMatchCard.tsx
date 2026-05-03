import React from 'react';
import { Sparkles, MapPin, Clock, DollarSign, Star, Briefcase } from 'lucide-react';
import { JobPost } from '../../types';
import { Button } from '../ui/Button';
import { MotionItem } from '../ui/Motion';

interface AiJobMatchCardProps {
  job: JobPost & { matchScore?: number; matchReasons?: string[] };
  onApply: (job: JobPost) => void;
  onViewDetails: (job: JobPost) => void;
}

export const AiJobMatchCard: React.FC<AiJobMatchCardProps> = ({
  job,
  onApply,
  onViewDetails
}) => {
  const matchScore = job.matchScore || 0;
  
  const getMatchColor = (score: number) => {
    if (score >= 85) return 'text-green-600 bg-green-50 border-green-200';
    if (score >= 70) return 'text-primary-600 bg-primary-50 border-primary-200';
    return 'text-accent-600 bg-accent-50 border-accent-200';
  };

  return (
    <MotionItem className="bg-white rounded-2xl border border-slate-200 shadow-md hover:shadow-xl transition-all overflow-hidden">
      {/* Match Score Badge */}
      <div className={`px-4 py-2 flex items-center justify-between ${getMatchScore(matchScore)}`}>
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          <span className="font-bold text-sm">{matchScore}% Match</span>
        </div>
        {job.matchReasons && job.matchReasons.length > 0 && (
          <span className="text-xs opacity-80 truncate max-w-[150px]">
            {job.matchReasons[0]}
          </span>
        )}
      </div>

      <div className="p-4">
        {/* Job Title & Rate */}
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="font-bold text-slate-900 text-lg">{job.title}</h3>
            <p className="text-sm text-slate-500">{job.clientName}</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-primary-600">${job.rate}</div>
            <div className="text-xs text-slate-400">per hour</div>
          </div>
        </div>

        {/* Job Details */}
        <div className="space-y-2 mb-4">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Clock className="w-4 h-4 text-slate-400" />
            <span>{job.date} • {job.startTime} - {job.endTime}</span>
          </div>
          {job.location && (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <MapPin className="w-4 h-4 text-slate-400" />
              <span>{job.location}</span>
            </div>
          )}
        </div>

        {/* Description Preview */}
        <p className="text-sm text-slate-600 mb-4 line-clamp-2">
          {job.description}
        </p>

        {/* Match Reasons */}
        {job.matchReasons && job.matchReasons.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold text-slate-500 mb-2">Why this matches you:</p>
            <div className="flex flex-wrap gap-1">
              {job.matchReasons.slice(0, 3).map((reason, idx) => (
                <span
                  key={idx}
                  className="px-2 py-1 bg-slate-100 text-slate-700 text-xs rounded-full"
                >
                  {reason}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onViewDetails(job)}
          >
            View Details
          </Button>
          <Button
            size="sm"
            onClick={() => onApply(job)}
          >
            Apply Now
          </Button>
        </div>
      </div>
    </MotionItem>
  );
};

// Helper function for match score colors
const getMatchScore = (score: number): string => {
  if (score >= 85) return 'text-green-600 bg-green-50 border-green-200';
  if (score >= 70) return 'text-primary-600 bg-primary-50 border-primary-200';
  return 'text-accent-600 bg-accent-50 border-accent-200';
};
