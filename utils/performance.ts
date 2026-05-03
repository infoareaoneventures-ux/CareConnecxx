import { useEffect, useState } from 'react';

/**
 * Performance Monitoring Hook
 * Tracks Core Web Vitals and reports to console/analytics
 */
export function usePerformanceMonitoring() {
  useEffect(() => {
    // Only run in production and if PerformanceObserver is supported
    if (import.meta.env.DEV || !('PerformanceObserver' in window)) return;

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Log to console in development
        if (import.meta.env.DEV) {
          console.log(`[Performance] ${entry.name}:`, entry.duration);
        }

        // Send to analytics in production
        if (entry.duration > 0) {
          // You could send to Google Analytics, Sentry, etc.
          // gtag('event', 'timing_complete', {
          //   name: entry.name,
          //   value: Math.round(entry.duration),
          // });
        }
      }
    });

    try {
      observer.observe({ entryTypes: ['measure', 'navigation'] });
    } catch (e) {
      console.warn('PerformanceObserver not supported');
    }

    return () => observer.disconnect();
  }, []);
}

/**
 * Preload critical resources
 */
export function preloadCriticalResources() {
  const criticalResources = [
    // Preload main font
    { rel: 'preload', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap', as: 'style' },
    // Preconnect to external domains
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
    { rel: 'preconnect', href: 'https://firestore.googleapis.com' },
  ];

  criticalResources.forEach(({ rel, href, as, crossOrigin }) => {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    if (as) link.setAttribute('as', as);
    if (crossOrigin) link.setAttribute('crossorigin', crossOrigin);
    document.head.appendChild(link);
  });
}

/**
 * Lazy load images with Intersection Observer
 */
export function useLazyImage(src: string) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!src) return;

    // If IntersectionObserver not supported, load immediately
    if (!('IntersectionObserver' in window)) {
      setImageSrc(src);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setImageSrc(src);
            observer.disconnect();
          }
        });
      },
      {
        rootMargin: '50px 0px',
        threshold: 0.01,
      }
    );

    // Create a placeholder element to observe
    const placeholder = document.createElement('div');
    placeholder.dataset.src = src;
    observer.observe(placeholder);

    return () => observer.disconnect();
  }, [src]);

  const handleLoad = () => setIsLoaded(true);

  return { imageSrc, isLoaded, handleLoad };
}

/**
 * Debounce function for performance
 */
export function debounce<T extends (...args: any[]) => void>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

/**
 * Throttle function for performance
 */
export function throttle<T extends (...args: any[]) => void>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Measure component render time
 */
export function useRenderTime(componentName: string) {
  useEffect(() => {
    if (import.meta.env.DEV) {
      const start = performance.now();
      return () => {
        const duration = performance.now() - start;
        if (duration > 16) { // Longer than one frame (60fps)
          console.warn(`[Performance] ${componentName} took ${duration.toFixed(2)}ms to render`);
        }
      };
    }
  }, [componentName]);
}

/**
 * Report Core Web Vitals
 */
export function reportWebVitals() {
  if (!('web-vitals' in window)) return;

  // CLS - Cumulative Layout Shift
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!(entry as any).hadRecentInput) {
        const cls = (entry as any).value;
        if (cls > 0.1) {
          console.warn('[CLS] Layout shift detected:', cls);
        }
      }
    }
  }).observe({ entryTypes: ['layout-shift'] } as any);

  // LCP - Largest Contentful Paint
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const lastEntry = entries[entries.length - 1] as any;
    if (lastEntry) {
      console.log('[LCP] Largest Contentful Paint:', lastEntry.startTime);
    }
  }).observe({ entryTypes: ['largest-contentful-paint'] } as any);

  // FID - First Input Delay
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const delay = (entry as any).processingStart - (entry as any).startTime;
      if (delay > 100) {
        console.warn('[FID] First Input Delay:', delay);
      }
    }
  }).observe({ entryTypes: ['first-input'] } as any);
}
