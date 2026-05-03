import React, { ComponentType, lazy, Suspense } from 'react';

// Loading component
const LoadingFallback = () => (
    <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center space-y-4">
            <div className="w-16 h-16 border-4 border-teal-600 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-slate-600 font-medium">Loading...</p>
        </div>
    </div>
);

// Lazy load with retry logic
export const lazyWithRetry = (
    componentImport: () => Promise<{ default: ComponentType<any> }>
) => {
    return lazy(async () => {
        const pageHasAlreadyBeenForceRefreshed = JSON.parse(
            window.localStorage.getItem('page-has-been-force-refreshed') || 'false'
        );

        try {
            const component = await componentImport();
            window.localStorage.setItem('page-has-been-force-refreshed', 'false');
            return component;
        } catch (error) {
            if (!pageHasAlreadyBeenForceRefreshed) {
                // Assuming that the user is not on the latest version of the application
                window.localStorage.setItem('page-has-been-force-refreshed', 'true');
                window.location.reload();
                // Return a never-resolving promise to satisfy TypeScript
                return new Promise<never>(() => {});
            }

            // The page has already been reloaded
            // Assuming that user is already using the latest version of the application
            // Let the application crash and raise the error
            throw error;
        }
    });
};

// Lazy image component with loading placeholder
interface LazyImageProps {
    src: string;
    alt: string;
    className?: string;
    placeholder?: string;
}

export const LazyImage: React.FC<LazyImageProps> = ({
    src,
    alt,
    className = '',
    placeholder = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"%3E%3Crect fill="%23f1f5f9" width="400" height="300"/%3E%3C/svg%3E'
}) => {
    const [imageSrc, setImageSrc] = React.useState(placeholder);
    const [imageRef, setImageRef] = React.useState<HTMLImageElement | null>(null);

    React.useEffect(() => {
        let observer: IntersectionObserver;

        if (imageRef && 'IntersectionObserver' in window) {
            observer = new IntersectionObserver(
                (entries) => {
                    entries.forEach((entry) => {
                        if (entry.isIntersecting) {
                            setImageSrc(src);
                            observer.unobserve(imageRef);
                        }
                    });
                },
                {
                    rootMargin: '50px'
                }
            );

            observer.observe(imageRef);
        } else {
            // Fallback for browsers without IntersectionObserver
            setImageSrc(src);
        }

        return () => {
            if (observer && imageRef) {
                observer.unobserve(imageRef);
            }
        };
    }, [imageRef, src]);

    return (
        <img
            ref={setImageRef}
            src={imageSrc}
            alt={alt}
            className={className}
            loading="lazy"
        />
    );
};

// Preload critical resources
export const preloadCriticalResources = () => {
    // Preload fonts
    const fontLink = document.createElement('link');
    fontLink.rel = 'preload';
    fontLink.as = 'font';
    fontLink.type = 'font/woff2';
    fontLink.crossOrigin = 'anonymous';
    fontLink.href = '/fonts/inter-var.woff2';
    document.head.appendChild(fontLink);

    // Preconnect to external domains
    const domains = [
        'https://firebaseio.com',
        'https://fonts.googleapis.com',
        'https://fonts.gstatic.com'
    ];

    domains.forEach(domain => {
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = domain;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
    });
};

// Debounce function for performance
export const debounce = <T extends (...args: any[]) => any>(
    func: T,
    wait: number
): ((...args: Parameters<T>) => void) => {
    let timeout: NodeJS.Timeout;

    return (...args: Parameters<T>) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
};

// Throttle function for scroll/resize events
export const throttle = <T extends (...args: any[]) => any>(
    func: T,
    limit: number
): ((...args: Parameters<T>) => void) => {
    let inThrottle: boolean;

    return (...args: Parameters<T>) => {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => (inThrottle = false), limit);
        }
    };
};

// Virtual scrolling hook for long lists
export const useVirtualScroll = (
    itemCount: number,
    itemHeight: number,
    containerHeight: number
) => {
    const [scrollTop, setScrollTop] = React.useState(0);

    const visibleStart = Math.floor(scrollTop / itemHeight);
    const visibleEnd = Math.min(
        itemCount,
        Math.ceil((scrollTop + containerHeight) / itemHeight)
    );

    const offsetY = visibleStart * itemHeight;

    return {
        visibleStart,
        visibleEnd,
        offsetY,
        totalHeight: itemCount * itemHeight,
        onScroll: (e: React.UIEvent<HTMLDivElement>) => {
            setScrollTop(e.currentTarget.scrollTop);
        }
    };
};
