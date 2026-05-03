import { describe, it, expect, vi } from 'vitest';
import {
  hashSSN,
  maskSSN,
  maskPhone,
  sanitizeCaregiverPublic,
  isValidSSN,
  logPIIAccess
} from '../utils/encryption';

describe('Encryption Utilities', () => {
  // Note: encryptPII/decryptPII and prepareCaregiverForWrite require 
  // VITE_ENCRYPTION_KEY to be set. We test the functions that don't 
  // require the key here.

  describe('hashSSN', () => {
    it('should produce consistent hashes for same SSN', async () => {
      const ssn = '123456789';
      const hash1 = await hashSSN(ssn);
      const hash2 = await hashSSN(ssn);

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBeGreaterThan(0);
    });

    it('should produce different hashes for different SSNs', () => {
      const hash1 = hashSSN('123456789');
      const hash2 = hashSSN('987654321');
      
      expect(hash1).not.toBe(hash2);
    });

    it('should normalize SSNs (remove dashes)', () => {
      const hash1 = hashSSN('123-45-6789');
      const hash2 = hashSSN('123456789');
      
      expect(hash1).toBe(hash2);
    });

    it('should return empty string for empty input', () => {
      expect(hashSSN('')).toBe('');
    });
  });

  describe('maskSSN', () => {
    it('should mask SSN correctly', () => {
      expect(maskSSN('123456789')).toBe('***-**-6789');
      expect(maskSSN('123-45-6789')).toBe('***-**-6789');
    });

    it('should handle invalid SSNs', () => {
      expect(maskSSN('123')).toBe('***-**-****');
      expect(maskSSN('')).toBe('');
    });
  });

  describe('maskPhone', () => {
    it('should mask phone numbers correctly', () => {
      expect(maskPhone('5551234567')).toBe('(***) ***-4567');
      expect(maskPhone('555-123-4567')).toBe('(***) ***-4567');
    });

    it('should handle invalid phones', () => {
      expect(maskPhone('123')).toBe('(***) ***-****');
      expect(maskPhone('')).toBe('');
    });
  });

  describe('isValidSSN', () => {
    it('should validate correct SSNs', () => {
      expect(isValidSSN('123456789')).toBe(true);
      expect(isValidSSN('123-45-6789')).toBe(true);
    });

    it('should reject invalid SSNs', () => {
      expect(isValidSSN('000000000')).toBe(false);
      expect(isValidSSN('111111111')).toBe(false);
      expect(isValidSSN('12345')).toBe(false);
      expect(isValidSSN('')).toBe(false);
      expect(isValidSSN('abcdefghij')).toBe(false);
    });
  });

  describe('sanitizeCaregiverPublic', () => {
    it('should remove all PII from caregiver data', () => {
      const caregiver = {
        id: '123',
        name: 'John Doe',
        email: 'john@example.com',
        phone: '5551234567',
        hourlyRate: 30,
        verified: true,
        backgroundCheckData: {
          ssn: 'encrypted_ssn',
          dob: 'encrypted_dob'
        },
        stripeAccountId: 'acct_123'
      };

      const publicData = sanitizeCaregiverPublic(caregiver);

      expect(publicData.name).toBe('John Doe');
      expect(publicData.email).toBeUndefined();
      expect(publicData.phone).toBeUndefined();
      expect(publicData.backgroundCheckData).toBeUndefined();
      expect(publicData.stripeAccountId).toBeUndefined();
      expect(publicData.verified).toBe(true);
      expect(publicData.hourlyRate).toBe(30);
    });

    it('should handle null/undefined input', () => {
      expect(sanitizeCaregiverPublic(null)).toBeNull();
      expect(sanitizeCaregiverPublic(undefined)).toBeNull();
    });
  });

  describe('logPIIAccess', () => {
    it('should log access without errors', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      logPIIAccess('user123', 'read', 'ssn', 'target456');
      
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[AUDIT] PII Access:',
        expect.objectContaining({
          userId: 'user123',
          action: 'read',
          dataType: 'ssn',
          targetUserId: 'target456'
        })
      );
      
      consoleSpy.mockRestore();
    });
  });
});
