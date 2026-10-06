import firebase from 'firebase/compat/app';
import { storage as firebaseStorage } from '../lib/firebase';
import { dbService } from './api';
import type { CaregiverDocument, CaregiverDocuments, CaregiverDocumentRenewal } from '../types';

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
): Promise<CaregiverDocument & { asRenewal?: boolean }> {
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

    // Update Firestore with document metadata — as a RENEWAL beside an approved,
    // unexpired document (Transportation stays on), else as the document itself.
    const { asRenewal } = await updateDocumentMetadata(caregiverId, type, documentData);

    console.log('📄 Document uploaded:', path, 'Type:', type, asRenewal ? '(renewal)' : '');
    return { ...documentData, asRenewal };
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
/** An approved document whose expiry date has not passed (or has none) is still live — a new upload is a renewal, not a replacement. */
export function isLiveApproved(doc: CaregiverDocument | undefined | null, today = new Date()): boolean {
  if (!doc || doc.status !== 'approved') return false;
  if (!doc.expirationDate) return true;
  const [y, m, d] = doc.expirationDate.split('-').map(Number);
  const t = new Date(today); t.setHours(0, 0, 0, 0);
  return new Date(y, m - 1, d) >= t;
}

export async function updateDocumentMetadata(
  caregiverId: string,
  type: DocumentType,
  documentData: CaregiverDocument
): Promise<{ asRenewal: boolean }> {
  const db = firebase.firestore();
  const ref = db.collection('caregivers').doc(caregiverId);
  // Renewal slot (founder, 2026-10-05): uploading over a live approved transport
  // document must not knock the caregiver off Transportation while the new file
  // waits for review — it goes beside the live one; the admin's approval swaps it in.
  if (type !== 'profilePhoto') {
    const snap = await ref.get().catch(() => null);
    const current = (snap?.data() as any)?.documents?.[type] as CaregiverDocument | undefined;
    if (isLiveApproved(current)) {
      const renewal: CaregiverDocumentRenewal = {
        url: documentData.url, path: documentData.path, uploadedAt: documentData.uploadedAt, status: 'pending',
        ...(documentData.fileName ? { fileName: documentData.fileName } : {}),
        ...(documentData.fileType ? { fileType: documentData.fileType } : {}),
      };
      await ref.update({ [`documents.${type}.renewal`]: renewal });
      return { asRenewal: true };
    }
  }
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
        return { asRenewal: false };
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
  return { asRenewal: false };
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
 * Review a pending renewal (Admin only). Approved: the renewal becomes the live
 * document with its new expiry (the old one is gone). Rejected: the live document
 * stays until its own expiry; the reason is shown to the caregiver (2026-10-05).
 */
export async function reviewDocumentRenewal(
  caregiverId: string,
  type: DocumentType,
  decision: 'approved' | 'rejected',
  notes?: string,
  adminId?: string,
  expirationDate?: string
): Promise<void> {
  const db = firebase.firestore();
  const ref = db.collection('caregivers').doc(caregiverId);
  const snap = await ref.get();
  const current = (snap.data() as any)?.documents?.[type] as CaregiverDocument | undefined;
  const renewal = current?.renewal;
  if (!renewal) throw new Error('No renewal to review');
  const now = new Date().toISOString();
  if (decision === 'approved') {
    const live: CaregiverDocument = {
      url: renewal.url, path: renewal.path, uploadedAt: renewal.uploadedAt, status: 'approved',
      reviewedAt: now,
      ...(adminId !== undefined ? { reviewedBy: adminId } : {}),
      ...(renewal.fileName ? { fileName: renewal.fileName } : {}),
      ...(renewal.fileType ? { fileType: renewal.fileType } : {}),
      ...(expirationDate ? { expirationDate } : current?.expirationDate ? { expirationDate: current.expirationDate } : {}),
    };
    await ref.update({ [`documents.${type}`]: live }); // whole field: the renewal slot goes with it
    return;
  }
  const update: Record<string, any> = {
    [`documents.${type}.renewal.status`]: 'rejected',
    [`documents.${type}.renewal.reviewedAt`]: now,
  };
  if (adminId !== undefined) update[`documents.${type}.renewal.reviewedBy`] = adminId;
  if (notes !== undefined) update[`documents.${type}.renewal.notes`] = notes;
  await ref.update(update);
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
  reviewDocumentRenewal,
  isLiveApproved,
  getCaregiverDocuments,
  hasAllRequiredDocuments,
  getDocumentStatusSummary,
  getDocumentTypeName
};
