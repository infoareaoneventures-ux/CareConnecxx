import React, { useState, useRef, useCallback } from 'react';
import { Camera, Check, X, Smile, Frown, Meh, Sun, Moon, Pill, Utensils, Footprints, FileText, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Appointment, CareJournalEntry } from '../../types';
import { dbService } from '../../services/api';
import { storageService } from '../../services/storageService';

interface CareJournalEntryProps {
  appointment: Appointment;
  caregiverId: string;
  caregiverName: string;
  onSubmit: (entry: CareJournalEntry) => void;
  onCancel: () => void;
}

interface PhotoUpload {
  file: File;
  preview: string;
  uploading: boolean;
  error?: string;
  storageUrl?: string;
}

// Constants for validation
const MAX_PHOTOS = 10;
const MAX_PHOTO_SIZE_MB = 5;
const MAX_NOTE_LENGTH = 2000;
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Care Journal Entry Form
 * Quick, senior-friendly check-in for caregivers
 * HIPAA: Photos uploaded to secure Firebase Storage with access logging
 */
export const CareJournalEntryForm: React.FC<CareJournalEntryProps> = ({
  appointment,
  caregiverId,
  caregiverName,
  onSubmit,
  onCancel
}) => {
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form state
  const [checkInTime] = useState(new Date().toISOString());
  const [photos, setPhotos] = useState<PhotoUpload[]>([]);
  const [mood, setMood] = useState<'great' | 'good' | 'ok' | 'poor' | null>(null);
  const [wellness, setWellness] = useState({
    ateWell: false,
    tookMeds: false,
    wasActive: false,
    sleptWell: false
  });
  const [activities, setActivities] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  const ACTIVITY_OPTIONS = [
    { id: 'breakfast', label: 'Breakfast', icon: Utensils },
    { id: 'lunch', label: 'Lunch', icon: Utensils },
    { id: 'dinner', label: 'Dinner', icon: Utensils },
    { id: 'meds', label: 'Medication', icon: Pill },
    { id: 'walk', label: 'Walk/Exercise', icon: Footprints },
    { id: 'outing', label: 'Outing/Errands', icon: Sun },
    { id: 'companionship', label: 'Companionship', icon: Smile },
    { id: 'housekeeping', label: 'Housekeeping', icon: FileText }
  ];

  /**
   * Validate and process photo uploads
   */
  const handlePhotoUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    setUploadError(null);

    // Check total photo count
    if (photos.length + files.length > MAX_PHOTOS) {
      setUploadError(`Maximum ${MAX_PHOTOS} photos allowed. You can add ${MAX_PHOTOS - photos.length} more.`);
      return;
    }

    const newPhotos: PhotoUpload[] = [];

    for (const file of Array.from(files)) {
      // Validate file type
      if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
        setUploadError(`Invalid file type: ${file.name}. Only JPEG, PNG, and WebP allowed.`);
        continue;
      }

      // Validate file size
      if (file.size > MAX_PHOTO_SIZE_MB * 1024 * 1024) {
        setUploadError(`File too large: ${file.name}. Maximum size is ${MAX_PHOTO_SIZE_MB}MB.`);
        continue;
      }

      // Create preview
      const preview = URL.createObjectURL(file);
      
      const photoUpload: PhotoUpload = {
        file,
        preview,
        uploading: true
      };

      newPhotos.push(photoUpload);

      // Upload to Firebase Storage immediately
      try {
        const entryId = crypto.randomUUID();
        const storageUrl = await storageService.uploadCareJournalPhoto(
          file,
          entryId,
          caregiverId,
          appointment.clientId || 'unknown'
        );

        setPhotos(prev => 
          prev.map(p => 
            p.preview === preview 
              ? { ...p, uploading: false, storageUrl }
              : p
          )
        );
      } catch (error) {
        console.error('Failed to upload photo:', error);
        setPhotos(prev => 
          prev.map(p => 
            p.preview === preview 
              ? { ...p, uploading: false, error: 'Upload failed' }
              : p
          )
        );
        setUploadError('Failed to upload some photos. Please try again.');
      }
    }

    setPhotos(prev => [...prev, ...newPhotos]);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [photos.length, caregiverId, appointment.clientId]);

  const removePhoto = useCallback((preview: string) => {
    setPhotos(prev => {
      const photo = prev.find(p => p.preview === preview);
      if (photo) {
        URL.revokeObjectURL(photo.preview);
      }
      return prev.filter(p => p.preview !== preview);
    });
  }, []);

  const toggleActivity = (activity: string) => {
    setActivities(prev =>
      prev.includes(activity)
        ? prev.filter(a => a !== activity)
        : [...prev, activity]
    );
  };

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length <= MAX_NOTE_LENGTH) {
      setNotes(value);
    }
  };

  const handleSubmit = async () => {
    // Validation
    if (!mood) {
      setUploadError('Please select a mood rating');
      return;
    }

    // Check for upload errors
    const failedUploads = photos.filter(p => p.error);
    if (failedUploads.length > 0) {
      setUploadError('Some photos failed to upload. Please remove them and try again.');
      return;
    }

    // Check for pending uploads
    const pendingUploads = photos.filter(p => p.uploading);
    if (pendingUploads.length > 0) {
      setUploadError('Please wait for all photos to finish uploading.');
      return;
    }

    setIsSubmitting(true);
    setUploadError(null);

    try {
      const entry: CareJournalEntry = {
        id: crypto.randomUUID(),
        appointmentId: appointment.id,
        caregiverId,
        seniorId: appointment.clientId || '',
        timestamp: new Date().toISOString(),
        checkInTime,
        checkOutTime: new Date().toISOString(),
        photos: photos.map(p => p.storageUrl).filter((url): url is string => !!url),
        notes: notes.trim(),
        wellness: {
          ateWell: wellness.ateWell,
          tookMeds: wellness.tookMeds,
          wasActive: wellness.wasActive,
          mood: mood
        },
        activities
      };

      await dbService.createCareJournalEntry(entry);
      
      // Clean up preview URLs
      photos.forEach(p => URL.revokeObjectURL(p.preview));
      
      onSubmit(entry);
    } catch (error) {
      console.error('Failed to save journal entry:', error);
      setUploadError('Failed to save. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const canProceed = () => {
    if (step === 1) return mood !== null;
    return true;
  };

  return (
    <div className="bg-white rounded-3xl shadow-xl p-6 max-w-md mx-auto animate-slide-in">
      {/* Error Banner */}
      {uploadError && (
        <div className="mb-4 p-4 bg-red-50 border-2 border-red-200 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{uploadError}</p>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-slate-900">Visit Check-In</h2>
        <button onClick={onCancel} className="p-2 hover:bg-slate-100 rounded-full">
          <X className="w-6 h-6 text-slate-500" />
        </button>
      </div>

      {/* Progress */}
      <div className="flex gap-2 mb-6">
        {[1, 2, 3, 4].map(s => (
          <div
            key={s}
            className={`flex-1 h-2 rounded-full ${
              s <= step ? 'bg-primary-500' : 'bg-slate-200'
            }`}
          />
        ))}
      </div>

      {/* Step 1: Mood */}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-lg text-slate-700 text-center">
            How was <strong>{appointment.seniorName || 'your client'}</strong> today?
          </p>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMood('great')}
              className={`p-6 rounded-2xl border-2 flex flex-col items-center gap-2 transition-all ${
                mood === 'great'
                  ? 'border-emerald-500 bg-emerald-50'
                  : 'border-slate-200 hover:border-emerald-300'
              }`}
            >
              <Smile className={`w-12 h-12 ${mood === 'great' ? 'text-emerald-600' : 'text-slate-400'}`} />
              <span className={`font-semibold ${mood === 'great' ? 'text-emerald-700' : 'text-slate-600'}`}>
                Great
              </span>
            </button>

            <button
              onClick={() => setMood('good')}
              className={`p-6 rounded-2xl border-2 flex flex-col items-center gap-2 transition-all ${
                mood === 'good'
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-slate-200 hover:border-primary-300'
              }`}
            >
              <Sun className={`w-12 h-12 ${mood === 'good' ? 'text-primary-600' : 'text-slate-400'}`} />
              <span className={`font-semibold ${mood === 'good' ? 'text-primary-700' : 'text-slate-600'}`}>
                Good
              </span>
            </button>

            <button
              onClick={() => setMood('ok')}
              className={`p-6 rounded-2xl border-2 flex flex-col items-center gap-2 transition-all ${
                mood === 'ok'
                  ? 'border-accent-500 bg-accent-50'
                  : 'border-slate-200 hover:border-accent-300'
              }`}
            >
              <Meh className={`w-12 h-12 ${mood === 'ok' ? 'text-accent-600' : 'text-slate-400'}`} />
              <span className={`font-semibold ${mood === 'ok' ? 'text-accent-700' : 'text-slate-600'}`}>
                Okay
              </span>
            </button>

            <button
              onClick={() => setMood('poor')}
              className={`p-6 rounded-2xl border-2 flex flex-col items-center gap-2 transition-all ${
                mood === 'poor'
                  ? 'border-red-500 bg-red-50'
                  : 'border-slate-200 hover:border-red-300'
              }`}
            >
              <Frown className={`w-12 h-12 ${mood === 'poor' ? 'text-red-600' : 'text-slate-400'}`} />
              <span className={`font-semibold ${mood === 'poor' ? 'text-red-700' : 'text-slate-600'}`}>
                Not Great
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Wellness */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-lg text-slate-700 text-center">
            How did they do today?
          </p>

          <div className="space-y-3">
            <button
              onClick={() => setWellness(w => ({ ...w, ateWell: !w.ateWell }))}
              className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
                wellness.ateWell
                  ? 'border-emerald-500 bg-emerald-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className={`p-3 rounded-full ${wellness.ateWell ? 'bg-emerald-200' : 'bg-slate-100'}`}>
                <Utensils className={`w-6 h-6 ${wellness.ateWell ? 'text-emerald-700' : 'text-slate-500'}`} />
              </div>
              <span className={`font-semibold text-lg ${wellness.ateWell ? 'text-emerald-700' : 'text-slate-700'}`}>
                Ate well
              </span>
              {wellness.ateWell && <Check className="w-6 h-6 text-emerald-600 ml-auto" />}
            </button>

            <button
              onClick={() => setWellness(w => ({ ...w, tookMeds: !w.tookMeds }))}
              className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
                wellness.tookMeds
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className={`p-3 rounded-full ${wellness.tookMeds ? 'bg-blue-200' : 'bg-slate-100'}`}>
                <Pill className={`w-6 h-6 ${wellness.tookMeds ? 'text-blue-700' : 'text-slate-500'}`} />
              </div>
              <span className={`font-semibold text-lg ${wellness.tookMeds ? 'text-blue-700' : 'text-slate-700'}`}>
                Took medications
              </span>
              {wellness.tookMeds && <Check className="w-6 h-6 text-blue-600 ml-auto" />}
            </button>

            <button
              onClick={() => setWellness(w => ({ ...w, wasActive: !w.wasActive }))}
              className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
                wellness.wasActive
                  ? 'border-accent-500 bg-accent-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className={`p-3 rounded-full ${wellness.wasActive ? 'bg-accent-200' : 'bg-slate-100'}`}>
                <Footprints className={`w-6 h-6 ${wellness.wasActive ? 'text-accent-700' : 'text-slate-500'}`} />
              </div>
              <span className={`font-semibold text-lg ${wellness.wasActive ? 'text-accent-700' : 'text-slate-700'}`}>
                Was active
              </span>
              {wellness.wasActive && <Check className="w-6 h-6 text-accent-600 ml-auto" />}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Activities */}
      {step === 3 && (
        <div className="space-y-4">
          <p className="text-lg text-slate-700 text-center">
            What did you do together?
          </p>

          <div className="grid grid-cols-2 gap-3">
            {ACTIVITY_OPTIONS.map(activity => {
              const Icon = activity.icon;
              const isSelected = activities.includes(activity.id);
              return (
                <button
                  key={activity.id}
                  onClick={() => toggleActivity(activity.id)}
                  className={`p-4 rounded-xl border-2 flex flex-col items-center gap-2 transition-all ${
                    isSelected
                      ? 'border-primary-500 bg-primary-50'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <Icon className={`w-8 h-8 ${isSelected ? 'text-primary-600' : 'text-slate-400'}`} />
                  <span className={`text-sm font-medium text-center ${isSelected ? 'text-primary-700' : 'text-slate-600'}`}>
                    {activity.label}
                  </span>
                  {isSelected && <Check className="w-4 h-4 text-primary-600" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 4: Photos & Notes */}
      {step === 4 && (
        <div className="space-y-4">
          <p className="text-lg text-slate-700 text-center">
            Add photos or notes (optional)
          </p>

          {/* Photo Upload */}
          <div className="space-y-3">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              ref={fileInputRef}
              onChange={handlePhotoUpload}
              className="hidden"
            />

            {photos.length === 0 ? (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full p-8 border-2 border-dashed border-slate-300 rounded-xl flex flex-col items-center gap-3 hover:border-primary-400 hover:bg-primary-50 transition-all"
              >
                <Camera className="w-10 h-10 text-slate-400" />
                <span className="text-slate-600 font-medium">Tap to add photos</span>
                <span className="text-sm text-slate-400">Max {MAX_PHOTOS} photos, {MAX_PHOTO_SIZE_MB}MB each</span>
              </button>
            ) : (
              <div>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  {photos.map((photo, idx) => (
                    <div key={idx} className="relative aspect-square rounded-lg overflow-hidden border border-slate-200">
                      <img src={photo.preview} alt={`Photo ${idx + 1}`} className="w-full h-full object-cover" />
                      {photo.uploading && (
                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                          <Loader2 className="w-6 h-6 text-white animate-spin" />
                        </div>
                      )}
                      {photo.error && (
                        <div className="absolute inset-0 bg-red-500/80 flex items-center justify-center">
                          <AlertCircle className="w-6 h-6 text-white" />
                        </div>
                      )}
                      <button
                        onClick={() => removePhoto(photo.preview)}
                        className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full"
                        disabled={photo.uploading}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {photos.length < MAX_PHOTOS && (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="aspect-square border-2 border-dashed border-slate-300 rounded-xl flex items-center justify-center hover:border-primary-400"
                    >
                      <Camera className="w-6 h-6 text-slate-400" />
                    </button>
                  )}
                </div>
                <p className="text-sm text-slate-500 text-center">
                  {photos.length} of {MAX_PHOTOS} photos
                </p>
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="relative">
            <textarea
              placeholder="Anything else to share? (optional)"
              value={notes}
              onChange={handleNotesChange}
              className="w-full p-4 border-2 border-slate-200 rounded-xl text-lg focus:border-primary-500 focus:outline-none resize-none"
              rows={3}
            />
            <p className={`text-xs text-right mt-1 ${notes.length > MAX_NOTE_LENGTH * 0.9 ? 'text-accent-600' : 'text-slate-400'}`}>
              {notes.length}/{MAX_NOTE_LENGTH}
            </p>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-3 mt-8">
        {step > 1 && (
          <Button
            variant="outline"
            onClick={() => setStep(s => s - 1)}
            className="flex-1"
          >
            Back
          </Button>
        )}

        {step < 4 ? (
          <Button
            variant="primary"
            onClick={() => setStep(s => s + 1)}
            disabled={!canProceed()}
            className="flex-1"
          >
            Continue
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSubmitting || photos.some(p => p.uploading)}
            className="flex-1"
          >
            {isSubmitting ? (
              <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Saving...</>
            ) : (
              'Complete Check-In'
            )}
          </Button>
        )}
      </div>
    </div>
  );
};
