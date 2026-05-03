
import React, { useRef, useState } from 'react';
import { Camera, User, Loader2 } from 'lucide-react';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

interface AvatarUploadProps {
  currentUrl?: string;
  onImageSelected: (url: string) => void;
  size?: 'md' | 'lg';
  ariaLabel?: string;
  /** Firebase UID — if provided alongside storageFolder, uploads to Firebase Storage */
  userId?: string;
  /** Storage sub-folder, e.g. 'caregivers' or 'clients' */
  storageFolder?: string;
}

export const AvatarUpload: React.FC<AvatarUploadProps> = ({
  currentUrl,
  onImageSelected,
  size = 'lg',
  ariaLabel = "Upload profile picture",
  userId,
  storageFolder,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Upload to Firebase Storage when userId + storageFolder are provided
    if (userId && storageFolder) {
      setUploading(true);
      try {
        const storage = getStorage();
        const storageRef = ref(storage, `profile-photos/${storageFolder}/${userId}`);
        const snapshot = await uploadBytes(storageRef, file);
        const downloadUrl = await getDownloadURL(snapshot.ref);
        onImageSelected(downloadUrl);
      } catch (err) {
        console.error('Profile photo upload failed, falling back to base64:', err);
        // Fallback: read as base64 so the UI still updates
        const reader = new FileReader();
        reader.onloadend = () => {
          if (reader.result) onImageSelected(reader.result as string);
        };
        reader.readAsDataURL(file);
      } finally {
        setUploading(false);
        // Reset input so the same file can be re-selected
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
      return;
    }

    // No storage config — fall back to base64
    const reader = new FileReader();
    reader.onloadend = () => {
      if (reader.result) onImageSelected(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const containerSize = size === 'lg' ? 'w-24 h-24' : 'w-16 h-16';

  return (
    <div
      className="relative group cursor-pointer"
      onClick={() => !uploading && fileInputRef.current?.click()}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
    >
      <div className={`${containerSize} rounded-full border-4 border-white overflow-hidden bg-slate-200 shadow-sm relative`}>
        {currentUrl ? (
          <img
            src={currentUrl}
            alt="Current profile picture"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-400">
            <User size={32} aria-hidden="true" />
          </div>
        )}

        {/* Upload overlay */}
        <div
          className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          aria-hidden="true"
        >
          {uploading
            ? <Loader2 className="text-white w-6 h-6 animate-spin" />
            : <Camera className="text-white w-6 h-6" />
          }
        </div>

        {/* Uploading full overlay */}
        {uploading && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center" aria-hidden="true">
            <Loader2 className="text-white w-6 h-6 animate-spin" />
          </div>
        )}
      </div>

      {/* Edit badge */}
      <div
        className="absolute bottom-0 right-0 bg-slate-900 text-white p-1.5 rounded-full border-2 border-white shadow-sm group-hover:scale-110 transition-transform"
        aria-hidden="true"
      >
        {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
      </div>

      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*"
        onChange={handleFileChange}
        aria-hidden="true"
        tabIndex={-1}
        disabled={uploading}
      />
    </div>
  );
};
