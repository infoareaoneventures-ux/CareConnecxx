import React from 'react';
import { Heart, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { TOTAL_STEPS } from './types';

interface SignupLayoutProps {
  step: number;
  onCancel: () => void;
  children: React.ReactNode;
  sideContent?: React.ReactNode;
  sideImage?: string;
  /** Flip layout so image is on the left */
  imageLeft?: boolean;
}

export const SignupLayout: React.FC<SignupLayoutProps> = ({
  step,
  onCancel,
  children,
  sideContent,
  sideImage,
  imageLeft = false,
}) => {
  const navigate = useNavigate();
  const formPanel = (
    <div className="flex-1 flex flex-col min-h-screen lg:min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <Heart className="w-7 h-7 text-primary-600" fill="currentColor" />
          <span className="text-xl font-bold text-slate-800">CareConnecxx</span>
        </button>
        <button
          onClick={onCancel}
          className="text-slate-500 hover:text-slate-700 text-sm font-medium flex items-center gap-1 transition-colors"
        >
          Cancel
        </button>
      </div>

      {/* Form content */}
      <div className="flex-1 overflow-y-auto px-6 py-8 lg:px-12 lg:py-10">
        <div className="max-w-lg mx-auto">
          {children}
        </div>
      </div>

      {/* Progress dots */}
      <div className="flex items-center justify-center gap-2 py-4 border-t border-slate-100">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={`rounded-full transition-all duration-300 ${
              i + 1 === step
                ? 'w-3 h-3 bg-primary-600'
                : i + 1 < step
                ? 'w-2.5 h-2.5 bg-primary-400'
                : 'w-2.5 h-2.5 bg-slate-200'
            }`}
          />
        ))}
      </div>
    </div>
  );

  const sidePanel = (
    <div className="hidden lg:flex lg:w-[42%] relative overflow-hidden">
      {sideContent ? (
        <div className="w-full h-full bg-gradient-to-br from-primary-50 to-primary-100 p-8 flex flex-col justify-center">
          {sideContent}
        </div>
      ) : sideImage ? (
        <img
          src={sideImage}
          alt=""
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
          <div className="text-center text-white px-8">
            <Heart className="w-16 h-16 mx-auto mb-4 opacity-80" fill="currentColor" />
            <h3 className="text-2xl font-bold mb-2">Join CareConnecxx</h3>
            <p className="text-primary-100 text-lg">Connect with families who need your care</p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen flex bg-white">
      {imageLeft ? (
        <>
          {sidePanel}
          {formPanel}
        </>
      ) : (
        <>
          {formPanel}
          {sidePanel}
        </>
      )}
    </div>
  );
};
