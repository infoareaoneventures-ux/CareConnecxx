import React from 'react';
import { Caregiver } from '../types';
import { Star, MapPin, Clock, Video } from 'lucide-react';
import { DEFAULT_CAREGIVER_AVATAR } from '../constants';

interface InlineCaregiverCardProps {
    caregiver: Caregiver;
    onBook: (caregiverId: string) => void;
    onViewProfile?: (caregiver: Caregiver) => void;
    onScheduleInterview?: (caregiver: Caregiver) => void;
    compact?: boolean;
}

export const InlineCaregiverCard: React.FC<InlineCaregiverCardProps> = ({
    caregiver,
    onBook,
    onViewProfile,
    onScheduleInterview,
    compact = true
}) => {
    return (
        <div className={`
      bg-white rounded-lg border-2 border-slate-200 overflow-hidden
      hover:border-primary-400 hover:shadow-lg transition-all
      ${compact ? 'max-w-sm' : 'max-w-md'}
    `}>
            <div className="p-4">
                <div className="flex items-start gap-3">
                    {/* Photo */}
                    <div className="flex-shrink-0">
                        <img
                            src={caregiver.photo || caregiver.imageUrl || DEFAULT_CAREGIVER_AVATAR}
                            alt={caregiver.name}
                            className="w-16 h-16 rounded-full object-cover border-2 border-primary-100"
                            onError={(e) => { (e.target as HTMLImageElement).src = DEFAULT_CAREGIVER_AVATAR; }}
                        />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                            <h4 className="font-bold text-slate-900 truncate">{caregiver.name}</h4>
                            {caregiver.verified || caregiver.backgroundCheckStatus ? (
                                caregiver.backgroundCheckStatus === 'clear' || caregiver.verified ? (
                                    <span className="flex-shrink-0 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                                        ✓ BGC Cleared
                                    </span>
                                ) : (
                                    <span className="flex-shrink-0 text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
                                        ⏳ BGC Pending
                                    </span>
                                )
                            ) : null}
                        </div>

                        {/* Rating & Rate */}
                        <div className="flex items-center gap-3 mb-2">
                            {caregiver.rating && (
                                <div className="flex items-center gap-1 text-sm">
                                    <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                                    <span className="font-medium">{caregiver.rating.toFixed(1)}</span>
                                </div>
                            )}
                            <span className="text-lg font-bold text-primary-600">
                                ${caregiver.hourlyRate}/hr
                            </span>
                        </div>

                        {/* Skills */}
                        {caregiver.skills && caregiver.skills.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-2">
                                {caregiver.skills.slice(0, 3).map((skill, idx) => (
                                    <span
                                        key={idx}
                                        className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded"
                                    >
                                        {skill}
                                    </span>
                                ))}
                                {caregiver.skills.length > 3 && (
                                    <span className="text-xs text-slate-500">
                                        +{caregiver.skills.length - 3} more
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Distance */}
                        {caregiver.distance && (
                            <div className="flex items-center gap-1 text-xs text-slate-500">
                                <MapPin className="w-3 h-3" />
                                <span>{caregiver.distance.toFixed(1)} mi away</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Action Buttons */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                    <button
                        onClick={() => onBook(caregiver.id)}
                        className="px-2 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors flex items-center justify-center gap-1"
                    >
                        <Clock className="w-4 h-4" />
                        Book
                    </button>
                    {onViewProfile && (
                        <button
                            onClick={() => onViewProfile(caregiver)}
                            className="px-2 py-2 bg-slate-100 text-slate-700 rounded-lg font-medium hover:bg-slate-200 transition-colors"
                        >
                            Profile
                        </button>
                    )}
                    {onScheduleInterview && (
                        <button
                            onClick={() => onScheduleInterview(caregiver)}
                            className="px-2 py-2 bg-blue-100 text-blue-700 rounded-lg font-medium hover:bg-blue-200 transition-colors flex items-center justify-center gap-1"
                        >
                            <Video className="w-4 h-4" />
                            Call
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
