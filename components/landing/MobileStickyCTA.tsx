import React from 'react';
import { ViewType } from '../../types';

interface MobileStickyCTAProps {
    onNavigate: (view: ViewType) => void;
}

export const MobileStickyCTA: React.FC<MobileStickyCTAProps> = ({ onNavigate }) => {
    return (
        <div className="md:hidden fixed bottom-0 left-0 right-0 p-4 pb-5 z-50">
            <button
                onClick={() => onNavigate('client-signup')}
                className="btn-depth-primary w-full py-4 rounded-full font-semibold text-[15px]"
            >
                Find a caregiver
            </button>
        </div>
    );
};
