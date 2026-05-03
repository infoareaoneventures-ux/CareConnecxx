import React from 'react';
import { Phone } from 'lucide-react';

/**
 * Persistent Call Support Button for Seniors
 * Always visible, large tap target, clear visual hierarchy
 */
export const CallSupportButton: React.FC = () => {
  const handleClick = () => {
    window.location.href = 'tel:+1-800-CARE-123';
  };

  return (
    <button
      onClick={handleClick}
      className="
        fixed bottom-6 right-6 z-50
        bg-emerald-500 hover:bg-emerald-600
        text-white font-bold
        px-6 py-4 rounded-full
        shadow-xl shadow-emerald-500/30
        flex items-center gap-3
        min-h-[60px]
        text-lg
        transition-all duration-200
        hover:scale-105 active:scale-95
        border-4 border-white
      "
      aria-label="Call CareConnex Support"
    >
      <Phone className="w-6 h-6" />
      <span className="hidden sm:inline">Call Support</span>
    </button>
  );
};

/**
 * Inline Call Support Card - for use in empty states or help sections
 */
export const CallSupportCard: React.FC = () => {
  return (
    <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-6 text-center">
      <div className="bg-emerald-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
        <Phone className="w-8 h-8 text-emerald-600" />
      </div>
      <h3 className="text-xl font-bold text-slate-900 mb-2">Need Help?</h3>
      <p className="text-base text-slate-600 mb-4">
        Our care coordinators are available 24/7 to help you find the perfect caregiver.
      </p>
      <a
        href="tel:+1-800-CARE-123"
        className="
          inline-flex items-center justify-center gap-2
          bg-emerald-500 hover:bg-emerald-600
          text-white font-bold text-lg
          px-8 py-4 rounded-xl
          min-h-[56px]
          transition-all duration-200
          shadow-lg shadow-emerald-500/30
        "
      >
        <Phone className="w-5 h-5" />
        Call 1-800-CARE-123
      </a>
      <p className="text-sm text-slate-500 mt-3">Available 24 hours, 7 days a week</p>
    </div>
  );
};
