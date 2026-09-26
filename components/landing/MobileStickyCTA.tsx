import React, { useEffect, useState } from 'react';
import { ViewType } from '../../types';

interface MobileStickyCTAProps {
    onNavigate: (view: ViewType) => void;
}

// Phone-only "Find a caregiver" button pinned to the bottom of the home page.
// 2026-09-25 (founder): it used to float over the content from the first
// pixel — a second copy of the hero's own button, with no background, sitting
// on top of whatever scrolled beneath it. Now it appears only once the hero
// (and its button) has scrolled out of view, on a solid bar with a top border,
// and the page reserves space for it (LandingView's pb-20 md:pb-0).
export const MobileStickyCTA: React.FC<MobileStickyCTAProps> = ({ onNavigate }) => {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const hero = document.getElementById('hero');
        if (!hero || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
        const observer = new IntersectionObserver(
            ([entry]) => setVisible(!entry.isIntersecting),
            { threshold: 0, rootMargin: '-80px 0px 0px 0px' },
        );
        observer.observe(hero);
        return () => observer.disconnect();
    }, []);

    return (
        <div
            aria-hidden={!visible}
            className={`md:hidden fixed bottom-0 left-0 right-0 z-50 px-4 pt-3 bg-paper-50/95 backdrop-blur border-t hairline transition-transform duration-200 ${
                visible ? 'translate-y-0' : 'translate-y-full pointer-events-none'
            }`}
            style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
            <button
                onClick={() => onNavigate('client-signup')}
                tabIndex={visible ? 0 : -1}
                className="btn-depth-primary w-full py-4 rounded-full font-semibold text-[15px]"
            >
                Find a caregiver
            </button>
        </div>
    );
};
