import firebase from 'firebase/compat/app';
import { storage as firebaseStorage } from '../lib/firebase';
import { dbService } from './api';
import type { CaregiverDocument, CaregiverDocuments } from '../types';

/**
 * Caregiver Document Upload Service
 * Handles driver's license and vehicle registration uploads
 * with verification status tracking
 */

const MAX_FILE_SIZE_MB = 5;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/bmp', 'image/tiff', 'application/pdf'];

export type DocumentType = 'driversLicense' | 'driversLicenseBack' | 'registration' | 'insurance' | 'profilePhoto';

interface UploadProgressCallback {
  (progress: number): void;
}

/**
 * Validate file before upload
 */
function validateFile(file: File): void {
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf';
  if (!isImage && !isPdf) {
    throw new Error('Invalid file type. Please upload an image (JPG, PNG, HEIC, etc.) or PDF.');
  }

  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    throw new Error(`File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`);
  }
}

/**
 * Get document type display name
 */
export function getDocumentTypeName(type: DocumentType): string {
  const names: Record<DocumentType, string> = {
    driversLicense: "Driver's License (Front)",
    driversLicenseBack: "Driver's License (Back)",
    registration: "Vehicle Registration",
    insurance: "Vehicle Insurance",
    profilePhoto: "Profile Photo"
  };
  return names[type];
}

/**
 * Upload caregiver document to Firebase Storage
 * and update Firestore metadata
 */
export async function uploadDocument(
  caregiverId: string,
  file: File,
  type: DocumentType,
  onProgress?: UploadProgressCallback
): Promise<CaregiverDocument> {
  // Validate file
  validateFile(file);

  if (!firebaseStorage) throw new Error('Storage not initialized. Please refresh and try again.');

  try {
    // Create storage reference
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${timestamp}_${sanitizedName}`;
    const path = `caregivers/${caregiverId}/documents/${type}_${filename}`;
    const storageRef = firebaseStorage.ref().child(path);

    // Upload with metadata
    const metadata = {
      contentType: file.type,
      customMetadata: {
        uploadedBy: caregiverId,
        documentType: type,
        uploadTime: new Date().toISOString(),
        originalName: file.name,
        status: 'pending'
      }
    };

    // Start upload with progress tracking and handle completion/errors safely
    const snapshot = await new Promise<any>((resolve, reject) => {
      const uploadTask = storageRef.put(file, metadata);

      uploadTask.on('state_changed', 
        (snap) => {
          if (onProgress) {
            const progress = (snap.bytesTransferred / snap.totalBytes) * 100;
            onProgress(progress);
          }
        },
        (error) => {
          console.error('Upload observer error:', error);
          reject(error);
        },
        () => {
          resolve(uploadTask.snapshot);
        }
      );
    });
    const downloadUrl = await snapshot.ref.getDownloadURL();

    // Create document metadata
    const documentData: CaregiverDocument = {
      url: downloadUrl,
      path: path,
      uploadedAt: new Date().toISOString(),
      status: 'pending',
      fileName: file.name,
      fileType: file.type
    };

    // Update Firestore with document metadata
    await updateDocumentMetadata(caregiverId, type, documentData);

    console.log('📄 Document uploaded:', path, 'Type:', type);
    return documentData;
  } catch (error: any) {
    console.error('Failed to upload document:', error);
    const code = error?.code || '';
    if (code === 'storage/unauthorized') throw new Error('Upload permission denied. Please make sure you are logged in.');
    if (code === 'storage/quota-exceeded') throw new Error('Storage quota exceeded. Please contact support.');
    if (code === 'storage/invalid-checksum' || code === 'storage/canceled') throw new Error('Upload interrupted. Please try again.');
    throw new Error(error?.message || 'Document upload failed. Please try again.');
  }
}

/**
 * Update document metadata in Firestore
 */
export async function updateDocumentMetadata(
  caregiverId: string,
  type: DocumentType,
  documentData: CaregiverDocument
): Promise<void> {
  const db = firebase.firestore();
  const ref = db.collection('caregivers').doc(caregiverId);
  try {
    await ref.update({ [`documents.${type}`]: documentData });
  } catch (error: any) {
    if (error?.code === 'not-found') {
      // Document doesn't exist yet — create it with just this field
      try {
        await ref.set(
          { documents: { [type]: documentData } },
          { mergeFields: [new firebase.firestore.FieldPath('documents', type)] }
        );
        return;
      } catch (setError: any) {
        console.error('Failed to create document metadata:', setError);
        const code = setError?.code || '';
        if (code === 'permission-denied') throw new Error('Permission denied saving photo. Please log out and back in.');
        throw new Error(setError?.message || 'Failed to save document information');
      }
    }
    console.error('Failed to update document metadata:', error);
    const code = error?.code || '';
    if (code === 'permission-denied') throw new Error('Permission denied saving photo. Please log out and back in.');
    throw new Error(error?.message || 'Failed to save document information');
  }
}

/**
 * Get signed URL for viewing document
 * (Refreshes token if needed)
 */
export async function getDocumentUrl(path: string): Promise<string> {
  if (!firebaseStorage) throw new Error('Storage not initialized.');
  try {
    const storageRef = firebaseStorage.ref().child(path);
    return await storageRef.getDownloadURL();
  } catch (error) {
    console.error('Failed to get document URL:', error);
    throw new Error('Failed to retrieve document');
  }
}

/**
 * Delete document from storage and Firestore
 */
export async function deleteDocument(
  caregiverId: string,
  type: DocumentType,
  path: string
): Promise<void> {
  if (!firebaseStorage) throw new Error('Storage not initialized.');
  try {
    // Delete from Storage
    const storageRef = firebaseStorage.ref().child(path);
    await storageRef.delete();

    // Remove from Firestore
    await dbService.updateUser('caregivers', caregiverId, {
      documents: {
        [type]: null
      }
    });

    console.log('🗑️ Document deleted:', path);
  } catch (error) {
    console.error('Failed to delete document:', error);
    throw new Error('Failed to delete document');
  }
}

/**
 * Update document verification status (Admin only)
 */
export async function updateDocumentStatus(
  caregiverId: string,
  type: DocumentType,
  status: 'pending' | 'approved' | 'rejected',
  notes?: string,
  adminId?: string,
  expirationDate?: string
): Promise<void> {
  try {
    const db = firebase.firestore();
    const caregiverRef = db.collection('caregivers').doc(caregiverId);

    const update: Record<string, any> = {
      [`documents.${type}.status`]: status,
      [`documents.${type}.reviewedAt`]: new Date().toISOString(),
    };
    if (adminId !== undefined) update[`documents.${type}.reviewedBy`] = adminId;
    if (notes !== undefined) update[`documents.${type}.notes`] = notes;
    if (expirationDate) update[`documents.${type}.expirationDate`] = expirationDate;

    // When profile photo is approved, promote its URL to the top-level photo field
    // so the profile page displays it immediately
    if (type === 'profilePhoto' && status === 'approved') {
      const snap = await caregiverRef.get();
      const photoUrl = (snap.data() as any)?.documents?.profilePhoto?.url;
      if (photoUrl) update['photo'] = photoUrl;
    }

    await caregiverRef.update(update);

    console.log('✓ Document status updated:', caregiverId, type, status);
  } catch (error: any) {
    console.error('Failed to update document status:', error);
    const code = error?.code || '';
    if (code === 'permission-denied') throw new Error('Permission denied. Make sure your admin account has userType: admin or isAdmin: true in Firestore.');
    throw new Error(error?.message || 'Failed to update document status');
  }
}

/**
 * Get all documents for a caregiver
 */
export async function getCaregiverDocuments(
  caregiverId: string
): Promise<CaregiverDocuments | null> {
  try {
    const caregiver = await dbService.getUser(caregiverId);
    return caregiver?.documents || null;
  } catch (error) {
    console.error('Failed to get caregiver documents:', error);
    return null;
  }
}

/**
 * Check if all required documents are uploaded
 */
export function hasAllRequiredDocuments(
  documents?: CaregiverDocuments | null
): boolean {
  if (!documents) return false;

  return !!(
    documents.driversLicense &&
    documents.insurance &&
    documents.registration
  );
}

/**
 * Get document upload status summary
 */
export function getDocumentStatusSummary(
  documents?: CaregiverDocuments | null
): {
  total: number;
  uploaded: number;
  approved: number;
  pending: number;
  rejected: number;
} {
  if (!documents) {
    return { total: 3, uploaded: 0, approved: 0, pending: 0, rejected: 0 };
  }

  const docs = [
    documents.driversLicense,
    documents.driversLicenseBack,
    documents.insurance,
    documents.registration,
  ].filter(Boolean);

  return {
    total: docs.length,
    uploaded: docs.length,
    approved: docs.filter(d => d?.status === 'approved').length,
    pending: docs.filter(d => d?.status === 'pending').length,
    rejected: docs.filter(d => d?.status === 'rejected').length
  };
}

export const documentUploadService = {
  uploadDocument,
  updateDocumentMetadata,
  getDocumentUrl,
  deleteDocument,
  updateDocumentStatus,
  getCaregiverDocuments,
  hasAllRequiredDocuments,
  getDocumentStatusSummary,
  getDocumentTypeName
};
