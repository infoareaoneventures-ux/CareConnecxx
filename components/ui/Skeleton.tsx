import React from 'react';

interface SkeletonProps {
    className?: string;
    count?: number;
    /**
     * Accessible label for screen readers
     * @default "Loading"
     */
    ariaLabel?: string;
}

/**
 * Skeleton loading placeholder with accessibility support
 * 
 * @example
 * <Skeleton count={3} className="h-4" ariaLabel="Loading posts" />
 */
export const Skeleton: React.FC<SkeletonProps> = ({ 
    className, 
    count = 1, 
    ariaLabel = "Loading" 
}) => {
    return (
        <div aria-busy="true" aria-label={ariaLabel} role="status">
            <span className="sr-only">{ariaLabel}</span>
            {Array.from({ length: count }).map((_, i) => (
                <div
                    key={i}
                    className={`animate-pulse bg-[var(--color-neutral-200)] rounded-lg ${className}`}
                    aria-hidden="true"
                />
            ))}
        </div>
    );
};

/**
 * Card-shaped skeleton loader
 */
export const CardSkeleton: React.FC<{ ariaLabel?: string }> = ({ 
    ariaLabel = "Loading card" 
}) => (
    <div 
        className="bg-white p-4 rounded-2xl border border-[var(--color-neutral-100)] shadow-sm flex flex-col"
        aria-busy="true"
        aria-label={ariaLabel}
        role="status"
    >
        <span className="sr-only">{ariaLabel}</span>
        <div className="flex items-center gap-3 mb-3">
            <Skeleton className="w-12 h-12 rounded-full" ariaLabel="Loading avatar" />
            <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
            </div>
        </div>
        <div className="mt-auto space-y-3">
            <div className="flex justify-between">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-9 w-full rounded-xl" />
        </div>
    </div>
);
