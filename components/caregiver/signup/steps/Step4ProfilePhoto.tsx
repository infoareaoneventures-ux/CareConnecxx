import React, { useRef } from 'react';
import { Camera, Upload, Star, MapPin, Loader2 } from 'lucide-react';
import { Button } from '../../../ui/Button';

interface Step4Props {
  profilePhoto: { file: File | null; preview: string | null };
  firstName: string;
  city: string;
  state: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  isLoading: boolean;
}

export const Step4ProfilePhoto: React.FC<Step4Props> = ({
  profilePhoto,
  firstName,
  city,
  state,
  onChange,
  onNext,
  onBack,
  onShowToast,
  isLoading,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      onShowToast('Photo must be under 5MB', 'error');
      return;
    }

    if (!file.type.startsWith('image/')) {
      onShowToast('Please select an image file', 'error');
      return;
    }

    const preview = URL.createObjectURL(file);
    onChange('profilePhoto', { file, preview });
  };

  const handleContinue = () => {
    if (!profilePhoto.file) {
      onShowToast('Please upload a profile photo', 'error');
      return;
    }
    onNext();
  };

  // Profile preview card (shown in side panel)
  const ProfilePreviewCard = () => (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden max-w-xs mx-auto">
      <div className="p-4">
        <div className="text-center mb-3">
          <p className="text-sm font-semibold text-slate-800">
            {firstName || 'Your'}'s Profile
          </p>
        </div>
        <div className="flex justify-center mb-3">
          {profilePhoto.preview ? (
            <img
              src={profilePhoto.preview}
              alt="Profile preview"
              className="w-28 h-28 rounded-full object-cover border-4 border-white shadow-md"
            />
          ) : (
            <div className="w-28 h-28 rounded-full bg-slate-200 flex items-center justify-center border-4 border-white shadow-md">
              <Camera className="w-10 h-10 text-slate-400" />
            </div>
          )}
        </div>
        <div className="flex items-center justify-center gap-0.5 mb-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <Star key={i} className="w-4 h-4 text-primary-400" fill="currentColor" />
          ))}
          <span className="text-sm text-slate-500 ml-1">New</span>
        </div>
        {(city || state) && (
          <div className="flex items-center justify-center gap-1 text-sm text-slate-500">
            <MapPin className="w-3.5 h-3.5" />
            {[city, state].filter(Boolean).join(', ')}
          </div>
        )}
        <p className="text-xs text-slate-400 text-center mt-2">New Caregiver</p>
      </div>
    </div>
  );

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">
        Select your profile photo
      </h1>
      <p className="text-slate-500 mb-6">Make a great first impression</p>

      {/* Upload area */}
      <div
        onClick={() => fileInputRef.current?.click()}
        className="cursor-pointer mb-6"
      >
        {profilePhoto.preview ? (
          <div className="flex flex-col items-center">
            <img
              src={profilePhoto.preview}
              alt="Profile preview"
              className="w-36 h-36 rounded-full object-cover border-4 border-primary-100 shadow-lg mb-3"
            />
            <button className="text-primary-600 font-medium text-sm hover:underline">
              Change photo
            </button>
          </div>
        ) : (
          <div className="border-2 border-dashed border-slate-300 rounded-2xl p-8 text-center hover:border-primary-400 hover:bg-primary-50/30 transition-all">
            <div className="w-20 h-20 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
              <Upload className="w-8 h-8 text-slate-400" />
            </div>
            <p className="text-slate-600 font-medium">Click to upload your photo</p>
            <p className="text-sm text-slate-400 mt-1">JPG, PNG or WebP (max 5MB)</p>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Photo Guidelines */}
      <div className="bg-slate-50 rounded-xl p-4 mb-6">
        <h3 className="font-semibold text-slate-700 mb-2">Photo Guidelines:</h3>
        <ul className="space-y-1.5 text-sm text-slate-600">
          <li className="flex items-start gap-2">
            <span className="text-red-400 font-bold">x</span>
            Do not select photos with other people, sunglasses, or hats.
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-500 font-bold">&#10003;</span>
            Choose a close-up photo.
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary-500 font-bold">&#10003;</span>
            Recent photos ensure new families can recognize you.
          </li>
        </ul>
      </div>

      {/* Mobile-only profile preview */}
      <div className="lg:hidden mb-6">
        <ProfilePreviewCard />
      </div>

      <div className="flex gap-3">
        <Button variant="secondary" size="lg" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleContinue}
          disabled={isLoading}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Uploading...
            </span>
          ) : (
            'Continue'
          )}
        </Button>
      </div>
    </div>
  );
};

// Export the side panel content separately
export const Step4SideContent: React.FC<{
  profilePhoto: { file: File | null; preview: string | null };
  firstName: string;
  city: string;
  state: string;
}> = ({ profilePhoto, firstName, city, state }) => (
  <div className="flex flex-col items-center justify-center h-full">
    <p className="text-slate-600 font-medium mb-6 text-center">
      This is how families will see you
    </p>
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden max-w-xs w-full">
      <div className="p-6">
        <div className="text-center mb-3">
          <p className="font-semibold text-slate-800">
            {firstName || 'Your'}'s Profile
          </p>
        </div>
        <div className="flex justify-center mb-3">
          {profilePhoto.preview ? (
            <img
              src={profilePhoto.preview}
              alt="Profile preview"
              className="w-28 h-28 rounded-full object-cover border-4 border-white shadow-md"
            />
          ) : (
            <div className="w-28 h-28 rounded-full bg-slate-200 flex items-center justify-center border-4 border-white shadow-md">
              <Camera className="w-10 h-10 text-slate-400" />
            </div>
          )}
        </div>
        <div className="flex items-center justify-center gap-0.5 mb-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <Star key={i} className="w-4 h-4 text-primary-400" fill="currentColor" />
          ))}
          <span className="text-sm text-slate-500 ml-1">New</span>
        </div>
        {(city || state) && (
          <div className="flex items-center justify-center gap-1 text-sm text-slate-500 mb-2">
            <MapPin className="w-3.5 h-3.5" />
            {[city, state].filter(Boolean).join(', ')}
          </div>
        )}
        <p className="text-xs text-slate-400 text-center">New Caregiver</p>
      </div>
    </div>
  </div>
);
