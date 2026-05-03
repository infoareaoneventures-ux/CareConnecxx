import React from 'react';
import { Sparkles, Loader2, MessageSquare, ShieldCheck, Star, Video } from 'lucide-react';
import { Caregiver } from '../../types';
import { Button } from '../ui/Button';
import { StaggerContainer, MotionItem } from '../ui/Motion';
import { Skeleton } from '../ui/Skeleton';

interface MatchCarouselProps {
    caregivers: Caregiver[];
    loading: boolean;
    onChat: (caregiver: Caregiver) => void;
    onHire: (caregiver: Caregiver) => void;
    onScheduleInterview?: (caregiver: Caregiver) => void;
    onSeeAll: () => void;
    creatingThreadId: string | number | null;
}

/**
 * Safely converts a caregiver ID to string for comparison
 * with runtime validation
 */
function normalizeCaregiverId(id: string | number | undefined): string | null {
    if (id === undefined || id === null) return null;
    if (typeof id === 'string') return id;
    if (typeof id === 'number' && !isNaN(id)) return String(id);
    console.warn('Invalid caregiver ID type:', typeof id);
    return null;
}

/**
 * Compares two caregiver IDs safely
 */
function isSameCaregiverId(
    creatingId: string | number | null | undefined,
    caregiverId: string | number | undefined
): boolean {
    const normalizedCreatingId = creatingId !== null && creatingId !== undefined 
        ? normalizeCaregiverId(creatingId) 
        : null;
    const normalizedCaregiverId = normalizeCaregiverId(caregiverId);
    
    if (normalizedCreatingId === null || normalizedCaregiverId === null) {
        return false;
    }
    
    return normalizedCreatingId === normalizedCaregiverId;
}

export const MatchCarousel: React.FC<MatchCarouselProps> = ({
    caregivers,
    loading,
    onChat,
    onHire,
    onScheduleInterview,
    onSeeAll,
    creatingThreadId
}) => {
    return (
        <div className="mb-8">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-bold text-[var(--color-neutral-900)] flex items-center">
                    <Sparkles className="w-5 h-5 mr-2 text-[var(--color-primary-600)]" />
                    Top Matches for You
                </h3>
                <button 
                    onClick={onSeeAll} 
                    className="text-sm font-semibold text-[var(--color-primary-600)] hover:text-[var(--color-primary-700)]"
                >
                    See all
                </button>
            </div>

            {loading ? (
                <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="min-w-[280px]">
                            <Skeleton className="h-64 w-full rounded-3xl" />
                        </div>
                    ))}
                </div>
            ) : caregivers.length === 0 ? (
                <div className="text-center p-8 bg-[var(--color-neutral-50)] rounded-2xl">
                    <p className="text-[var(--color-neutral-500)]">No matches found. Try adjusting your search criteria.</p>
                </div>
            ) : (
                <StaggerContainer className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
                    {caregivers.slice(0, 4).map((caregiver) => (
                        <MotionItem key={normalizeCaregiverId(caregiver.id) || `caregiver-${Math.random()}`} className="min-w-[280px] bg-white p-5 rounded-3xl border border-[var(--color-neutral-100)] shadow-sm hover:shadow-md transition-all flex flex-col">
                            <div className="flex items-start justify-between mb-4">
                                <img 
                                    src={caregiver.imageUrl} 
                                    alt={caregiver.name} 
                                    className="w-16 h-16 rounded-2xl object-cover"
                                    onError={(e) => {
                                        (e.target as HTMLImageElement).src = '/default-avatar.png';
                                    }}
                                />
                                <div className="text-right">
                                    <span className="block text-2xl font-bold text-[var(--color-neutral-900)]">${caregiver.hourlyRate}</span>
                                    <span className="text-xs text-[var(--color-neutral-400)]">per hour</span>
                                </div>
                            </div>

                            <div className="mb-2">
                                <h3 className="font-bold text-lg text-[var(--color-neutral-900)] flex items-center">
                                    {caregiver.name}
                                    {caregiver.verified && <ShieldCheck className="w-4 h-4 text-[var(--color-info-500)] ml-1" />}
                                </h3>
                                <div className="flex items-center text-sm text-[var(--color-neutral-500)]">
                                    <Star className="w-4 h-4 text-[var(--color-accent-400)] fill-current mr-1" />
                                    <span className="font-medium text-[var(--color-neutral-900)] mr-1">{caregiver.matchScore}% Match</span>
                                </div>
                            </div>

                            <div className="flex flex-wrap gap-1 mb-4">
                                {caregiver.personalityTags?.slice(0, 3).map((tag, i) => (
                                    <span key={i} className="px-2 py-1 bg-[var(--color-neutral-100)] text-[var(--color-neutral-600)] text-[10px] rounded-lg font-medium">
                                        {tag}
                                    </span>
                                ))}
                            </div>

                            {(caregiver.matchReasoning || caregiver.matchFlags) && (
                                <div className="mb-3 text-[10px] p-2 bg-[var(--color-neutral-50)] rounded-lg">
                                    {caregiver.matchReasoning && (
                                        <p className="text-[var(--color-neutral-600)] italic">"{caregiver.matchReasoning}"</p>
                                    )}
                                    {caregiver.matchFlags && caregiver.matchFlags.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {caregiver.matchFlags.map((flag, i) => (
                                                <span key={i} className="text-[var(--color-error-500)] font-bold">{flag}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            <div className="mt-auto grid grid-cols-3 gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => onChat(caregiver)}
                                    disabled={isSameCaregiverId(creatingThreadId, caregiver.id)}
                                >
                                    {isSameCaregiverId(creatingThreadId, caregiver.id) ? 
                                        <Loader2 className="w-4 h-4 animate-spin" /> : 
                                        <MessageSquare className="w-4 h-4" />
                                    }
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => onHire(caregiver)}
                                >
                                    Profile
                                </Button>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    className="bg-blue-100 text-blue-700 hover:bg-blue-200 border-blue-200"
                                    onClick={() => onScheduleInterview?.(caregiver)}
                                >
                                    <Video className="w-4 h-4" />
                                </Button>
                            </div>
                        </MotionItem>
                    ))}
                </StaggerContainer>
            )}
        </div>
    );
};
