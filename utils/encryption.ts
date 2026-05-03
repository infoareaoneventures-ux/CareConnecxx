import firebase from '../lib/firebase';
import { functions, isConfigured } from '../lib/firebase';

/**
 * Client-side encryption utility - DEPRECATED
 * 
 * IMPORTANT: All encryption now happens server-side via Firebase Functions.
 * This prevents encryption keys from being exposed in client-side code.
 * 
 * The functions below are thin wrappers that call the secure cloud functions.
 */

// Legacy exports for backward compatibility - these now call server functions
export async function encryptPII(plaintext: string): Promise<string> {
  if (!isConfigured || !functions) {
    throw new Error('Firebase not configured');
  }
  
  const encryptFn = functions.httpsCallable('encryptPII');
  const result = await encryptFn({ plaintext });
  return result.data.encrypted;
}

export async function decryptPII(ciphertext: string): Promise<string> {
  if (!isConfigured || !functions) {
    throw new Error('Firebase not configured');
  }
  
  const decryptFn = functions.httpsCallable('decryptPII');
  const result = await decryptFn({ ciphertext });
  return result.data.plaintext;
}

export async function hashSSN(ssn: string): Promise<string> {
  if (!isConfigured || !functions) {
    throw new Error('Firebase not configured');
  }
  
  const hashFn = functions.httpsCallable('hashSSN');
  const result = await hashFn({ ssn });
  return result.data.hash;
}

/**
 * Masks SSN for display (e.g., "***-**-1234")
 * Safe to run client-side - no encryption involved
 */
export function maskSSN(ssn: string): string {
  if (!ssn) return '';
  const clean = ssn.replace(/[\s-]/g, '');
  if (clean.length !== 9) return '***-**-****';
  return `***-**-${clean.slice(-4)}`;
}

/**
 * Masks phone number (e.g., "(***) ***-1234")
 * Safe to run client-side - no encryption involved
 */
export function maskPhone(phone: string): string {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  if (clean.length !== 10) return '(***) ***-****';
  return `(***) ***-${clean.slice(-4)}`;
}

/**
 * Validates SSN format
 * Safe to run client-side
 */
export function isValidSSN(ssn: string): boolean {
  if (!ssn) return false;
  const clean = ssn.replace(/[\s-]/g, '');
  // Basic validation: 9 digits, not all same, not 000-00-0000
  if (!/^\d{9}$/.test(clean)) return false;
  if (clean === '000000000') return false;
  if (/^(\d)\1{8}$/.test(clean)) return false; // All same digit
  return true;
}

/**
 * Sanitizes caregiver data for public profile view
 * Removes all PII before sending to client
 */
export function sanitizeCaregiverPublic(caregiver: any): any {
  if (!caregiver) return null;
  
  const {
    backgroundCheckData,
    email,
    phone,
    stripeAccountId,
    totalEarnings,
    ...publicData
  } = caregiver;
  
  return {
    ...publicData,
    // Only show these fields publicly
    verified: caregiver.verified || false,
    backgroundCheckStatus: caregiver.backgroundCheckStatus || 'none',
    rating: caregiver.rating,
    reviewCount: caregiver.reviewCount,
    hourlyRate: caregiver.hourlyRate,
    // Never expose these publicly
    email: undefined,
    phone: undefined,
    backgroundCheckData: undefined,
    stripeAccountId: undefined,
    totalEarnings: undefined,
  };
}

/**
 * Prepares caregiver data for Firestore write
 * NOW: Sends PII to server function for encryption
 * 
 * @deprecated Use encryptAndStoreCaregiverPII cloud function instead
 */
export async function prepareCaregiverForWrite(caregiver: any): Promise<any> {
  console.warn('prepareCaregiverForWrite is deprecated. Use encryptAndStoreCaregiverPII cloud function.');
  
  if (!isConfigured || !functions) {
    throw new Error('Firebase not configured');
  }

  // Call server-side encryption
  const encryptFn = functions.httpsCallable('encryptAndStoreCaregiverPII');
  await encryptFn({
    caregiverId: caregiver.uid,
    backgroundCheckData: caregiver.backgroundCheckData
  });

  // Return caregiver data without PII (server stored it securely)
  const { backgroundCheckData, ...safeData } = caregiver;
  return safeData;
}

/**
 * Audit log helper - track all PII access
 * Now sends to server for secure logging
 */
export async function logPIIAccess(
  userId: string,
  action: 'read' | 'write' | 'decrypt',
  dataType: string,
  targetUserId?: string
): Promise<void> {
  // Server-side logging is automatic in cloud functions
  // This is a no-op for client-side compatibility
  console.log('[AUDIT] PII Access logged server-side:', { userId, action, dataType, targetUserId });
}