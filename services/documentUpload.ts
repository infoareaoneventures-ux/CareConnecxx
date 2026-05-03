import firebase from 'firebase/compat/app';
import 'firebase/compat/storage';
import { dbService } from './api';
import type { CaregiverDocument, CaregiverDocuments } from '../types';

/**
 * Caregiver Document Upload Service
 * Handles driver's license and vehicle registration uploads
 * with verification status tracking
 */

const MAX_FILE_SIZE_MB = 5;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export type DocumentType = 'driversLicense' | 'driversLicenseBack' | 'registration' | 'profilePhoto';

interface UploadProgressCallback {
  (progress: number): void;
}

/**
 * Validate file before upload
 */
function validateFile(file: File): void {
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error('Invalid file type. Only JPEG, PNG, WebP, and PDF files are allowed.');
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

  try {
    // Create storage reference
    const storage = firebase.storage();
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${timestamp}_${sanitizedName}`;
    const path = `caregivers/${caregiverId}/documents/${type}_${filename}`;
    const storageRef = storage.ref().child(path);

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

    // Start upload with progress tracking
    const uploadTask = storageRef.put(file, metadata);

    // Track progress if callback provided
    if (onProgress) {
      uploadTask.on('state_changed', 
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          onProgress(progress);
        },
        (error) => {
          console.error('Upload error:', error);
        }
      );
    }

    // Wait for upload to complete
    const snapshot = await uploadTask;
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
  } catch (error) {
    console.error('Failed to upload document:', error);
    throw new Error('Document upload failed. Please try again.');
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
  try {
    const updateData: Partial<CaregiverDocuments> = {
      [type]: documentData
    };

    await dbService.updateUser('caregivers', caregiverId, {
      documents: updateData
    });
  } catch (error) {
    console.error('Failed to update document metadata:', error);
    throw new Error('Failed to save document information');
  }
}

/**
 * Get signed URL for viewing document
 * (Refreshes token if needed)
 */
export async function getDocumentUrl(path: string): Promise<string> {
  try {
    const storage = firebase.storage();
    const storageRef = storage.ref().child(path);
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
  try {
    // Delete from Storage
    const storage = firebase.storage();
    const storageRef = storage.ref().child(path);
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
  adminId?: string
): Promise<void> {
  try {
    const updateData: Partial<CaregiverDocument> = {
      status,
      reviewedAt: new Date().toISOString(),
      reviewedBy: adminId,
      notes
    };

    // Update Firestore
    const db = firebase.firestore();
    const caregiverRef = db.collection('caregivers').doc(caregiverId);
    
    await caregiverRef.update({
      [`documents.${type}.status`]: status,
      [`documents.${type}.reviewedAt`]: updateData.reviewedAt,
      [`documents.${type}.reviewedBy`]: adminId,
      [`documents.${type}.notes`]: notes
    });

    console.log('✓ Document status updated:', caregiverId, type, status);
  } catch (error) {
    console.error('Failed to update document status:', error);
    throw new Error('Failed to update document status');
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
    return { total: 2, uploaded: 0, approved: 0, pending: 0, rejected: 0 };
  }

  const docs = [
    documents.driversLicense,
    documents.registration
  ].filter(Boolean);

  return {
    total: 2,
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
