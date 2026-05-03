import { useEffect, useState, useRef, useCallback, TouchEvent } from 'react';

interface SwipeHandlers {
    onSwipeLeft?: () => void;
    onSwipeRight?: () => void;
    onSwipeUp?: () => void;
    onSwipeDown?: () => void;
}

interface SwipeConfig {
    threshold?: number; // Minimum distance for swipe (default: 50px)
    timeout?: number;   // Maximum time for swipe (default: 300ms)
}

export const useSwipe = (handlers: SwipeHandlers, config: SwipeConfig = {}) => {
    const { threshold = 50, timeout = 300 } = config;
    const touchStart = useRef<{ x: number; y: number; time: number } | null>(null);

    const onTouchStart = (e: TouchEvent) => {
        const touch = e.touches[0];
        touchStart.current = {
            x: touch.clientX,
            y: touch.clientY,
            time: Date.now()
        };
    };

    const onTouchEnd = (e: TouchEvent) => {
        if (!touchStart.current) return;

        const touch = e.changedTouches[0];
        const deltaX = touch.clientX - touchStart.current.x;
        const deltaY = touch.clientY - touchStart.current.y;
        const deltaTime = Date.now() - touchStart.current.time;

        // Check if swipe was fast enough
        if (deltaTime > timeout) {
            touchStart.current = null;
            return;
        }

        // Determine swipe direction
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        if (absX > absY && absX > threshold) {
            // Horizontal swipe
            if (deltaX > 0) {
                handlers.onSwipeRight?.();
            } else {
                handlers.onSwipeLeft?.();
            }
        } else if (absY > absX && absY > threshold) {
            // Vertical swipe
            if (deltaY > 0) {
                handlers.onSwipeDown?.();
            } else {
                handlers.onSwipeUp?.();
            }
        }

        touchStart.current = null;
    };

    return {
        onTouchStart,
        onTouchEnd
    };
};

// Pull to refresh hook
export const usePullToRefresh = (onRefresh: () => Promise<void>) => {
    const [isPulling, setIsPulling] = useState(false);
    const [pullDistance, setPullDistance] = useState(0);
    const startY = useRef(0);
    const threshold = 80;

    const onTouchStart = (e: TouchEvent) => {
        // Only trigger if at top of page
        if (window.scrollY === 0) {
            startY.current = e.touches[0].clientY;
        }
    };

    const onTouchMove = (e: TouchEvent) => {
        if (startY.current === 0) return;

        const currentY = e.touches[0].clientY;
        const distance = currentY - startY.current;

        if (distance > 0 && window.scrollY === 0) {
            setPullDistance(Math.min(distance, threshold * 1.5));
            if (distance > 10) {
                e.preventDefault();
            }
        }
    };

    const onTouchEnd = async () => {
        if (pullDistance >= threshold) {
            setIsPulling(true);
            try {
                await onRefresh();
            } catch (error) {
                console.error('Pull to refresh failed:', error);
            } finally {
                setIsPulling(false);
            }
        }
        setPullDistance(0);
        startY.current = 0;
    };

    return {
        isPulling,
        pullDistance,
        onTouchStart,
        onTouchMove,
        onTouchEnd
    };
};

// Haptic feedback hook
export const useHaptic = () => {
    const vibrate = (pattern: number | number[]) => {
        if ('vibrate' in navigator) {
            navigator.vibrate(pattern);
        }
    };

    return {
        light: () => vibrate(10),
        medium: () => vibrate(20),
        heavy: () => vibrate(30),
        success: () => vibrate([10, 50, 10]),
        error: () => vibrate([50, 100, 50]),
        warning: () => vibrate([30, 50, 30])
    };
};

// Long press hook
export const useLongPress = (
    callback: () => void,
    duration: number = 500
) => {
    const timeout = useRef<ReturnType<typeof setTimeout>>();

    const start = useCallback(() => {
        timeout.current = setTimeout(() => {
            try {
                callback();
            } catch (error) {
                console.error('Long press callback failed:', error);
            }
        }, duration);
    }, [callback, duration]);

    const clear = useCallback(() => {
        if (timeout.current) {
            clearTimeout(timeout.current);
        }
    }, []);

    return {
        onTouchStart: start,
        onTouchEnd: clear,
        onTouchMove: clear
    };
};
