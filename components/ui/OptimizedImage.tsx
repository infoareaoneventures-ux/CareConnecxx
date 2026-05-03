import React, { useState, useEffect, useRef } from 'react';

interface OptimizedImageProps {
  src: string;
  alt: string;
  className?: string;
  width?: number;
  height?: number;
  loading?: 'lazy' | 'eager';
  priority?: boolean;
  placeholder?: string;
  onLoad?: () => void;
  onError?: () => void;
}

/**
 * Optimized Image Component
 * 
 * Features:
 * - Lazy loading with IntersectionObserver
 * - Blur-up placeholder effect
 * - Responsive image loading
 * - WebP format support with fallback
 * - Prevents layout shift with aspect ratio
 */
export const OptimizedImage: React.FC<OptimizedImageProps> = ({
  src,
  alt,
  className = '',
  width,
  height,
  loading = 'lazy',
  priority = false,
  placeholder,
  onLoad,
  onError
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Intersection Observer for lazy loading
  useEffect(() => {
    if (priority || loading === 'eager') {
      setIsInView(true);
      return;
    }

    if (!('IntersectionObserver' in window)) {
      setIsInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true);
            observer.disconnect();
          }
        });
      },
      {
        rootMargin: '50px 0px',
        threshold: 0.01,
      }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [priority, loading]);

  const handleLoad = () => {
    setIsLoaded(true);
    onLoad?.();
  };

  const handleError = () => {
    setError(true);
    onError?.();
  };

  // Calculate aspect ratio for preventing layout shift
  const aspectRatio = width && height ? (height / width) * 100 : null;

  // Generate WebP src if possible (for Unsplash URLs)
  const getOptimizedSrc = (originalSrc: string) => {
    if (originalSrc.includes('unsplash.com') || originalSrc.includes('picsum.photos')) {
      // Add format and quality parameters for Unsplash
      return originalSrc.replace(/\?.*$/, '') + '?auto=format&fit=crop&w=800&q=80';
    }
    return originalSrc;
  };

  const optimizedSrc = getOptimizedSrc(src);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden ${className}`}
      style={{
        aspectRatio: aspectRatio ? `${width}/${height}` : undefined,
      }}
    >
      {/* Placeholder blur effect */}
      {!isLoaded && placeholder && (
        <div
          className="absolute inset-0 bg-slate-200 animate-pulse"
          style={{
            filter: 'blur(20px)',
            transform: 'scale(1.1)',
          }}
          aria-hidden="true"
        >
          <img
            src={placeholder}
            alt=""
            className="w-full h-full object-cover opacity-50"
          />
        </div>
      )}

      {/* Skeleton placeholder */}
      {!isLoaded && !placeholder && (
        <div className="absolute inset-0 bg-slate-200 animate-pulse skeleton" aria-hidden="true" />
      )}

      {/* Main image */}
      {isInView && !error && (
        <img
          ref={imgRef}
          src={optimizedSrc}
          alt={alt}
          width={width}
          height={height}
          loading={loading}
          decoding={priority ? 'sync' : 'async'}
          onLoad={handleLoad}
          onError={handleError}
          className={`
            w-full h-full object-cover transition-opacity duration-300
            ${isLoaded ? 'opacity-100' : 'opacity-0'}
          `}
        />
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-100 text-slate-400">
          <svg
            className="w-12 h-12"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </div>
      )}
    </div>
  );
};

/**
 * Preload critical images
 */
export const preloadImage = (src: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = src;
  });
};

/**
 * Generate responsive image srcset
 */
export const generateSrcSet = (src: string, widths: number[] = [400, 800, 1200]): string => {
  if (src.includes('unsplash.com')) {
    return widths
      .map((w) => `${src.replace(/\?.*$/, '')}?w=${w}&q=80 ${w}w`)
      .join(', ');
  }
  return '';
};
