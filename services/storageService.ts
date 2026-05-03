/**
 * HIPAA-Compliant Storage Service
 * Handles secure file uploads for photos and videos
 * 
 * Note: This is a mock implementation for demo purposes.
 * In production, this would integrate with Firebase Storage.
 */

import { auth, db, isConfigured } from '../lib/firebase';
import firebase from '../lib/firebase';

export interface UploadMediaOptions {
  file: File;
  appointmentId: string;
  clientId: string;
  caregiverId: string;
  onProgress?: (progress: number) => void;
}

export interface UploadResult {
  url: string;
  path: string;
  type: 'image' | 'video';
  thumbnailUrl?: string;
}

// Max file sizes
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB

// Allowed MIME types
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm'];

// Get storage reference dynamically
function getStorage() {
  // @ts-ignore - Firebase compat types
  return firebase.storage ? firebase.storage() : null;
}

/**
 * Validates file for HIPAA-compliant upload
 */
function validateFile(file: File): string | null {
  // Check file type
  const isImage = ALLOWED_IMAGE_TYPES.includes(file.type);
  const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type);

  if (!isImage && !isVideo) {
    return `File type "${file.type}" not allowed. Please use JPEG, PNG, HEIC, MP4, or MOV.`;
  }

  // Check file size
  if (isImage && file.size > MAX_IMAGE_SIZE) {
    return `Image size exceeds 10MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
  }
  if (isVideo && file.size > MAX_VIDEO_SIZE) {
    return `Video size exceeds 100MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
  }

  // Check for potentially malicious files
  const suspiciousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.js', '.php'];
  const hasSuspiciousExtension = suspiciousExtensions.some(ext => 
    file.name.toLowerCase().endsWith(ext)
  );
  if (hasSuspiciousExtension) {
    return 'Suspicious file extension detected';
  }

  return null;
}

/**
 * Generates a HIPAA-compliant secure path
 * Uses client ID prefix for data isolation
 */
function generateSecurePath(clientId: string, appointmentId: string, fileName: string): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  
  // Structure: media/{clientId}/{appointmentId}/{timestamp}_{random}_{filename}
  return `media/${clientId}/${appointmentId}/${timestamp}_${randomSuffix}_${sanitizedFileName}`;
}

/**
 * Creates a mock upload result for demo purposes
 */
function createMockUploadResult(file: File): UploadResult {
  const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type);
  return {
    url: URL.createObjectURL(file),
    path: `mock/${Date.now()}_${file.name}`,
    type: isVideo ? 'video' : 'image'
  };
}

/**
 * Uploads media file with HIPAA compliance
 * - Validates file type and size
 * - Generates secure path
 * - In production: Encrypts at rest and logs access
 */
export async function uploadMedia(options: UploadMediaOptions): Promise<UploadResult> {
  const { file, appointmentId, clientId, caregiverId, onProgress } = options;

  // Validate file
  const validationError = validateFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  // Simulate progress
  if (onProgress) {
    let progress = 0;
    const interval = setInterval(() => {
      progress += 10;
      onProgress(Math.min(progress, 100));
      if (progress >= 100) clearInterval(interval);
    }, 100);
  }

  // Simulate upload delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Create mock result
  const result = createMockUploadResult(file);

  // Log upload for HIPAA audit trail (best effort)
  try {
    await logMediaAccess('upload', result.path, clientId, appointmentId);
  } catch (e) {
    // Silent fail for logging
  }

  return result;
}

/**
 * Downloads media file
 * Logs access for HIPAA audit trail
 */
export async function downloadMedia(url: string, fileName: string): Promise<void> {
  // Log access
  await logMediaAccess('download', url, 'unknown', 'unknown');

  // Trigger download
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Deletes media file
 * Logs access for HIPAA audit trail
 */
export async function deleteMedia(path: string, clientId: string, appointmentId: string): Promise<void> {
  // Log deletion
  await logMediaAccess('delete', path, clientId, appointmentId);
}

/**
 * Logs media access for HIPAA audit compliance
 */
async function logMediaAccess(
  action: 'upload' | 'download' | 'view' | 'delete',
  path: string,
  clientId: string,
  appointmentId: string
): Promise<void> {
  if (!isConfigured || !db || !auth?.currentUser) {
    return;
  }

  try {
    await db.collection('media_access_logs').add({
      action,
      path,
      clientId,
      appointmentId,
      userId: auth.currentUser.uid,
      userEmail: auth.currentUser.email,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      ipAddress: 'client-side'
    });
  } catch (error) {
    console.error('Failed to log media access:', error);
  }
}

/**
 * Gets media items for a client with access logging
 */
export async function getClientMedia(clientId: string): Promise<UploadResult[]> {
  // Log bulk access
  await logMediaAccess('view', `media/${clientId}`, clientId, 'bulk');
  return [];
}

async function uploadCareJournalPhoto(file: File, entryId: string, caregiverId: string, clientId: string): Promise<string> {
  const result = await uploadMedia({ file, appointmentId: entryId, clientId, caregiverId });
  return result.url;
}

export const storageService = {
  uploadMedia,
  downloadMedia,
  deleteMedia,
  getClientMedia,
  uploadCareJournalPhoto,
};

export default storageService;
