import React, { useState, useRef, useCallback } from 'react';
import { Camera, Video, X, Upload, CheckCircle, AlertCircle, Loader2, Image as ImageIcon } from 'lucide-react';
import { Button } from '../ui/Button';
import { storageService } from '../../services/storageService';
import { dbService } from '../../services/api';
import { AddToastFunction } from '../../types';

interface VideoUpdateUploaderProps {
  appointmentId: string;
  clientId: string;
  caregiverId: string;
  caregiverName: string;
  onUploadComplete?: () => void;
  onShowToast: AddToastFunction;
}

interface UploadProgress {
  fileName: string;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
  url?: string;
}

/**
 * HIPAA-Compliant Video/Photo Update Uploader
 * Caregivers can upload photos/videos during shifts
 * Files are encrypted at rest and access is logged
 */
export const VideoUpdateUploader: React.FC<VideoUpdateUploaderProps> = ({
  appointmentId,
  clientId,
  caregiverId,
  caregiverName,
  onUploadComplete,
  onShowToast
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [caption, setCaption] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
  const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/heic'];
  const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-m4v'];

  const validateFile = (file: File): string | null => {
    if (file.size > MAX_FILE_SIZE) {
      return `File ${file.name} exceeds 100MB limit`;
    }
    
    const isImage = ALLOWED_IMAGE_TYPES.includes(file.type);
    const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type);
    
    if (!isImage && !isVideo) {
      return `File type not supported. Please use JPEG, PNG, HEIC, MP4, or MOV`;
    }
    
    return null;
  };

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    const validFiles: File[] = [];
    
    for (const file of selectedFiles) {
      const error = validateFile(file);
      if (error) {
        onShowToast(error, 'error');
      } else {
        validFiles.push(file);
      }
    }
    
    if (validFiles.length > 0) {
      setFiles(prev => [...prev, ...validFiles]);
    }
    
    // Reset input
    if (event.target) {
      event.target.value = '';
    }
  }, [onShowToast]);

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const uploadFiles = async () => {
    if (files.length === 0) {
      onShowToast('Please select at least one file', 'error');
      return;
    }

    setIsUploading(true);
    const newUploads: UploadProgress[] = files.map(f => ({
      fileName: f.name,
      progress: 0,
      status: 'uploading'
    }));
    setUploads(newUploads);

    try {
      const uploadPromises = files.map(async (file, index) => {
        try {
          // HIPAA-compliant upload with encryption
          const result = await storageService.uploadMedia({
            file,
            appointmentId,
            clientId,
            caregiverId,
            onProgress: (progress) => {
              setUploads(prev => {
                const updated = [...prev];
                updated[index] = { ...updated[index], progress };
                return updated;
              });
            }
          });

          setUploads(prev => {
            const updated = [...prev];
            updated[index] = { 
              ...updated[index], 
              progress: 100, 
              status: 'completed',
              url: result.url
            };
            return updated;
          });

          return result;
        } catch (error) {
          setUploads(prev => {
            const updated = [...prev];
            updated[index] = { ...updated[index], status: 'error' };
            return updated;
          });
          throw error;
        }
      });

      const results = await Promise.allSettled(uploadPromises);
      const successful = results.filter(r => r.status === 'fulfilled');
      
      if (successful.length > 0) {
        // Create media record in database
        const mediaUrls = successful
          .map(r => (r as PromiseFulfilledResult<{url: string; path: string; type: string}>).value)
          .filter(Boolean);

        await dbService.createMediaUpdate({
          appointmentId,
          clientId,
          caregiverId,
          caregiverName,
          media: mediaUrls,
          caption: caption.trim(),
          timestamp: new Date().toISOString()
        });

        // Notify family
        await dbService.notifyFamilyOfMediaUpdate({
          clientId,
          caregiverName,
          mediaCount: mediaUrls.length,
          appointmentId
        });

        onShowToast(
          `Successfully uploaded ${successful.length} file${successful.length > 1 ? 's' : ''}! Family has been notified.`,
          'success'
        );

        // Reset and close
        setFiles([]);
        setCaption('');
        setIsOpen(false);
        onUploadComplete?.();
      }

      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        onShowToast(`${failed.length} file(s) failed to upload`, 'error');
      }
    } catch (error) {
      console.error('Upload error:', error);
      onShowToast('Upload failed. Please try again.', 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-primary-500 to-blue-500 text-white rounded-xl font-semibold shadow-lg hover:shadow-xl transition-all hover:scale-105"
      >
        <Camera className="w-5 h-5" />
        <span>Share Update</span>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-slide-in">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-br from-primary-500 to-blue-500 p-2 rounded-xl">
              <Camera className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">Share Update</h3>
              <p className="text-xs text-slate-500">Photos & videos are encrypted</p>
            </div>
          </div>
          <button
            onClick={() => {
              setIsOpen(false);
              setFiles([]);
              setCaption('');
            }}
            className="p-2 hover:bg-slate-100 rounded-xl transition-colors"
          >
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* File Selection Area */}
          {files.length === 0 ? (
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-6 border-2 border-dashed border-slate-300 rounded-2xl hover:border-primary-500 hover:bg-primary-50 transition-all flex flex-col items-center gap-3"
              >
                <div className="w-12 h-12 bg-primary-100 rounded-xl flex items-center justify-center">
                  <ImageIcon className="w-6 h-6 text-primary-600" />
                </div>
                <span className="font-semibold text-slate-700">Add Photos</span>
                <span className="text-xs text-slate-500">JPEG, PNG, HEIC</span>
              </button>

              <button
                onClick={() => videoInputRef.current?.click()}
                className="p-6 border-2 border-dashed border-slate-300 rounded-2xl hover:border-blue-500 hover:bg-blue-50 transition-all flex flex-col items-center gap-3"
              >
                <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                  <Video className="w-6 h-6 text-blue-600" />
                </div>
                <span className="font-semibold text-slate-700">Add Video</span>
                <span className="text-xs text-slate-500">MP4, MOV (max 100MB)</span>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* File List */}
              {files.map((file, index) => (
                <div 
                  key={index} 
                  className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200"
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    file.type.startsWith('video/') ? 'bg-blue-100' : 'bg-primary-100'
                  }`}>
                    {file.type.startsWith('video/') ? (
                      <Video className="w-5 h-5 text-blue-600" />
                    ) : (
                      <ImageIcon className="w-5 h-5 text-primary-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-900 truncate">{file.name}</p>
                    <p className="text-sm text-slate-500">{formatFileSize(file.size)}</p>
                  </div>
                  {isUploading ? (
                    uploads[index] && (
                      <div className="flex items-center gap-2">
                        {uploads[index].status === 'completed' ? (
                          <CheckCircle className="w-5 h-5 text-emerald-500" />
                        ) : uploads[index].status === 'error' ? (
                          <AlertCircle className="w-5 h-5 text-red-500" />
                        ) : (
                          <div className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-primary-500 transition-all"
                              style={{ width: `${uploads[index].progress}%` }}
                            />
                          </div>
                        )}
                      </div>
                    )
                  ) : (
                    <button
                      onClick={() => removeFile(index)}
                      className="p-1 hover:bg-red-100 rounded-lg transition-colors"
                    >
                      <X className="w-4 h-4 text-red-500" />
                    </button>
                  )}
                </div>
              ))}

              {/* Add More Button */}
              {!isUploading && (
                <div className="flex gap-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 py-2 border-2 border-dashed border-slate-300 rounded-xl hover:border-primary-500 hover:bg-primary-50 transition-all text-sm font-medium text-slate-600"
                  >
                    + Add Photos
                  </button>
                  <button
                    onClick={() => videoInputRef.current?.click()}
                    className="flex-1 py-2 border-2 border-dashed border-slate-300 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition-all text-sm font-medium text-slate-600"
                  >
                    + Add Video
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Hidden Inputs */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/heic"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/x-m4v"
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Caption Input */}
          {files.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Add a caption (optional)
              </label>
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="What's happening in these photos?"
                maxLength={500}
                disabled={isUploading}
                className="w-full p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                rows={3}
              />
              <p className="text-xs text-slate-500 mt-1 text-right">
                {caption.length}/500
              </p>
            </div>
          )}

          {/* HIPAA Notice */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-blue-800">
              All media is encrypted and stored securely. Only authorized family members can view these updates.
            </p>
          </div>

          {/* Upload Button */}
          {files.length > 0 && (
            <Button
              onClick={uploadFiles}
              disabled={isUploading}
              fullWidth
              className="relative overflow-hidden"
            >
              {isUploading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Uploading...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Upload className="w-5 h-5" />
                  Upload {files.length} File{files.length > 1 ? 's' : ''}
                </span>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default VideoUpdateUploader;
