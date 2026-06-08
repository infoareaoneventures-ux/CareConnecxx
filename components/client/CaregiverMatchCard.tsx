import React, { useState } from 'react';
import { Star, Heart, MapPin, MessageSquare, DollarSign, CheckCircle, Briefcase } from 'lucide-react';
import { Caregiver } from '../../types';
import { CreditCardBadge } from '../shared/CreditCardBadge';
import { CaregiverVerificationBadges } from '../shared/CaregiverVerificationBadges';
import { TrustBadge } from '../shared/TrustBadge';

interface CaregiverMatchCardProps {
  caregiver: Caregiver;
  matchScore: number;
  matchReasons: string[];
  onBook: (caregiver: Caregiver) => void;
  onViewProfile: (caregiver: Caregiver) => void;
  onMessage?: (caregiver: Caregiver) => void;
  isSaved?: boolean;
  onToggleSave?: (caregiver: Caregiver) => void;
  isRequested?: boolean;
  hideSkills?: boolean;
}

export const CaregiverMatchCard: React.FC<CaregiverMatchCardProps> = ({
  caregiver,
  matchScore,
  matchReasons,
  onBook,
  onViewProfile,
  onMessage,
  isSaved = false,
  onToggleSave,
  isRequested = false,
  hideSkills = false,
}) => {
  const [imgErrored, setImgErrored] = useState(false);
  const photo = caregiver.imageUrl || (caregiver as any).photo || (caregiver as any).photoURL;
  const initials = caregiver.name.split(' ').map((p: string) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="bg-white rounded-[1.5rem] border border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col relative">
      {/* Favorite button */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleSave?.(caregiver); }}
        className="absolute top-4 right-4 p-2 bg-white/80 hover:bg-slate-50 backdrop-blur-sm rounded-full shadow-sm z-10 transition-colors"
        aria-label={isSaved ? 'Remove from saved' : 'Save caregiver'}
      >
        <Heart className={`w-5 h-5 transition-colors ${isSaved ? 'text-red-500 fill-current' : 'text-slate-400 hover:text-red-400'}`} />
      </button>

      {/* Clickable profile area */}
      <div
        className="p-5 flex-1 flex flex-col cursor-pointer group"
        onClick={() => onViewProfile(caregiver)}
      >
        {/* Photo + name + badges */}
        <div className="flex items-start gap-4 mb-5">
          <div className="w-20 h-20 rounded-full bg-slate-200 overflow-hidden flex items-center justify-center flex-shrink-0 shadow-inner group-hover:ring-4 ring-primary-50 transition-all">
            {photo && !imgErrored ? (
              <img
                src={photo}
                alt={caregiver.name}
                className="w-full h-full object-cover"
                onError={() => setImgErrored(true)}
              />
            ) : (
              <span className="text-2xl font-bold text-slate-400">{initials}</span>
            )}
          </div>

          <div className="flex-1 min-w-0 pt-1 pr-10">
            <h3 className="text-[22px] font-bold text-slate-900 group-hover:text-primary-600 transition-colors truncate mb-1 leading-tight">
              {caregiver.name}
            </h3>

            {/* Stars */}
            <div className="flex items-center gap-0.5 mb-2.5">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`w-[18px] h-[18px] ${i < Math.floor(caregiver.rating || 0) ? 'text-teal-500 fill-current' : 'text-slate-200'}`}
                />
              ))}
              <span className="text-sm font-medium text-slate-500 ml-1.5">
                ({(caregiver as any).reviewCount || 0})
              </span>
            </div>

            <CreditCardBadge show={!!(caregiver as any).acceptsCreditCards} />

            <div className="mt-1.5 flex flex-wrap gap-1">
              <CaregiverVerificationBadges
                verified={(caregiver as any).verified}
                backgroundCheckStatus={(caregiver as any).backgroundCheckStatus}
              />
              <TrustBadge caregiver={caregiver} />
            </div>
          </div>
        </div>

        {/* Experience + location + rate */}
        <div className="space-y-3.5 mb-5 mt-1">
          <div className="flex items-center gap-3.5 text-slate-700">
            <Briefcase className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
            <span className="text-[17px]">
              {(() => {
                const exp = caregiver.experience;
                if (!exp) return '0 years experience';
                const s = String(exp);
                return /year/i.test(s) ? s : `${s} years experience`;
              })()}
            </span>
          </div>
          <div className="flex items-center gap-3.5 text-slate-700">
            <MapPin className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
            <span className="text-[17px]">
              {(() => {
                const cg = caregiver as any;
                if (cg.city) return `${cg.city}${cg.state ? `, ${cg.state}` : ''}${cg.zipCode ? ` ${cg.zipCode}` : ''}`;
                if (caregiver.distance > 0) return `${caregiver.distance} miles away`;
                return 'Location not set';
              })()}
            </span>
          </div>
          {caregiver.hourlyRate > 0 && (
            <div className="flex items-center gap-3.5 text-slate-700">
              <DollarSign className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
              <span className="text-[17px] font-semibold">${caregiver.hourlyRate}/hr</span>
            </div>
          )}
        </div>

        {/* Skills pills */}
        {!hideSkills && caregiver.skills && caregiver.skills.length > 0 ? (
          <div className="flex flex-wrap gap-2 mb-6 mt-1">
            {caregiver.skills.slice(0, 3).map((skill: string) => (
              <span key={skill} className="px-3.5 py-1.5 bg-slate-100 border border-slate-200 text-slate-800 text-[13px] font-medium rounded-[1rem]">
                {skill}
              </span>
            ))}
          </div>
        ) : (
          <div className="mb-6 mt-1" />
        )}

      </div>

      {/* Action buttons */}
      <div className="bg-slate-50 border-t border-slate-100 p-3 grid grid-cols-2 gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); onMessage?.(caregiver); }}
          className="flex-1 py-2 text-sm font-bold bg-white border-2 border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 hover:border-slate-300 transition-colors inline-flex items-center justify-center gap-1.5"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>
        {isRequested ? (
          <div className="w-full py-2 text-sm font-bold bg-slate-100 border-2 border-slate-200 text-slate-500 rounded-xl inline-flex items-center justify-center gap-1.5">
            <CheckCircle className="w-4 h-4" /> Interview Requested
          </div>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); onBook(caregiver); }}
            className="w-full py-2 text-sm font-bold bg-primary-600 border-2 border-primary-600 text-white rounded-xl hover:bg-primary-700 hover:border-primary-700 transition-colors"
          >
            Request Interview
          </button>
        )}
      </div>
    </div>
  );
};
