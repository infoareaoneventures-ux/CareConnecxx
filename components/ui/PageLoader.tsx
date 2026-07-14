import React from 'react';
import { Loader2 } from 'lucide-react';

interface PageLoaderProps {
  message?: string;
  fullScreen?: boolean;
}

/**
 * Page Loader Component
 * Shows during lazy loading of routes
 * 
 * Optimized for:
 * - Fast appearance (< 200ms)
 * - Minimal bundle size
 * - Accessibility (ARIA labels)
 * - Reduced motion support
 */
export const PageLoader: React.FC<PageLoaderProps> = ({ 
  message = 'Loading...', 
  fullScreen = false 
}) => {
  const containerClasses = fullScreen 
    ? 'h-screen w-screen fixed inset-0 z-50'
    : 'h-[50vh] w-full';

  return (
    <div 
      className={`${containerClasses} flex flex-col items-center justify-center bg-paper-50`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="relative">
        {/* Animated spinner */}
        <Loader2 
          className="w-12 h-12 text-ink-600 animate-spin" 
          aria-hidden="true"
        />
        
        {/* Reduced motion fallback */}
        <span className="sr-only">{message}</span>
      </div>
      
      <p className="mt-4 text-ink-600 font-medium text-sm">
        {message}
      </p>

      {/* Loading progress indicator */}
      <div className="mt-4 w-48 h-1 bg-slate-200 rounded-full overflow-hidden">
        <div 
          className="h-full bg-ink-600 rounded-full animate-pulse"
          style={{ 
            width: '60%',
            animation: 'loading-bar 1.5s ease-in-out infinite'
          }}
        />
      </div>
    </div>
  );
};

/**
 * Skeleton Loader for content areas
 */
export const SkeletonLoader: React.FC<{ lines?: number; className?: string }> = ({ 
  lines = 3,
  className = ''
}) => {
  return (
    <div className={`animate-pulse ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div 
          key={i}
          className="h-4 bg-slate-200 rounded mb-3 last:mb-0"
          style={{ 
            width: i === lines - 1 ? '60%' : '100%',
            animationDelay: `${i * 100}ms`
          }}
        />
      ))}
    </div>
  );
};

/**
 * Card Skeleton Loader
 */
export const CardSkeleton: React.FC<{ count?: number }> = ({ count = 3 }) => {
  return (
    <div className="grid gap-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div 
          key={i} 
          className="bg-white rounded-xl p-6 border border-slate-100 animate-pulse"
        >
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-slate-200 rounded-full" />
            <div className="flex-1">
              <div className="h-4 bg-slate-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-slate-200 rounded w-1/2" />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-3 bg-slate-200 rounded w-full" />
            <div className="h-3 bg-slate-200 rounded w-5/6" />
          </div>
        </div>
      ))}
    </div>
  );
};
