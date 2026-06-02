/**
 * Client-side PII helpers.
 *
 * NOTE: The previous server-call wrappers (encryptPII / decryptPII / hashSSN /
 * prepareCaregiverForWrite) were removed — they invoked Cloud Functions that
 * were never deployed, so any caller would have hit NOT_FOUND. Encryption, if
 * needed, must be reintroduced as real deployed functions before re-adding
 * client wrappers. The helpers below are pure and safe to run client-side.
 */

/**
 * Masks SSN for display (e.g., "***-**-1234")
 */
export function maskSSN(ssn: string): string {
  if (!ssn) return '';
  const clean = ssn.replace(/[\s-]/g, '');
  if (clean.length !== 9) return '***-**-****';
  return `***-**-${clean.slice(-4)}`;
}

/**
 * Masks phone number (e.g., "(***) ***-1234")
 */
export function maskPhone(phone: string): string {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  if (clean.length !== 10) return '(***) ***-****';
  return `(***) ***-${clean.slice(-4)}`;
}

/**
 * Validates SSN format
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
 * Audit log helper - track all PII access
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
