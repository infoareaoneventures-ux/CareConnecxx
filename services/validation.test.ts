import { describe, it, expect } from 'vitest';
import {
  validate,
  validateSafe,
  sanitizeString,
  validateImageFile,
  emailSchema,
  phoneSchema,
  ssnSchema,
  zipCodeSchema,
  caregiverSignupSchema,
  seniorSchema,
  appointmentSchema,
  messageSchema
} from '../utils/validation';

describe('Validation Utilities', () => {
  describe('emailSchema', () => {
    it('should validate correct emails', () => {
      expect(emailSchema.parse('test@example.com')).toBe('test@example.com');
      expect(emailSchema.parse('Test@Example.COM')).toBe('test@example.com'); // Normalized
    });

    it('should reject invalid emails', () => {
      expect(() => emailSchema.parse('not-an-email')).toThrow();
      expect(() => emailSchema.parse('@example.com')).toThrow();
      expect(() => emailSchema.parse('test@')).toThrow();
      expect(() => emailSchema.parse('a@b.c')).toThrow(); // Too short
    });
  });

  describe('phoneSchema', () => {
    it('should validate 10-digit phones', () => {
      expect(phoneSchema.parse('5551234567')).toBe('5551234567');
      expect(phoneSchema.parse('555-123-4567')).toBe('5551234567');
      expect(phoneSchema.parse('(555) 123-4567')).toBe('5551234567');
    });

    it('should reject invalid phones', () => {
      expect(() => phoneSchema.parse('123')).toThrow();
      expect(() => phoneSchema.parse('12345678901')).toThrow(); // 11 digits
      expect(() => phoneSchema.parse('abcdefghij')).toThrow();
    });
  });

  describe('ssnSchema', () => {
    it('should validate correct SSNs', () => {
      expect(ssnSchema.parse('123456789')).toBe('123456789');
      expect(ssnSchema.parse('123-45-6789')).toBe('123456789');
    });

    it('should reject invalid SSNs', () => {
      expect(() => ssnSchema.parse('000000000')).toThrow();
      expect(() => ssnSchema.parse('111111111')).toThrow();
      expect(() => ssnSchema.parse('12345')).toThrow();
      expect(() => ssnSchema.parse('1234567890')).toThrow();
    });
  });

  describe('zipCodeSchema', () => {
    it('should validate 5-digit ZIPs', () => {
      expect(zipCodeSchema.parse('12345')).toBe('12345');
    });

    it('should validate ZIP+4', () => {
      expect(zipCodeSchema.parse('12345-6789')).toBe('12345-6789');
    });

    it('should reject invalid ZIPs', () => {
      expect(() => zipCodeSchema.parse('1234')).toThrow();
      expect(() => zipCodeSchema.parse('123456')).toThrow();
    });
  });

  describe('caregiverSignupSchema', () => {
    const validCaregiver = {
      name: 'John Doe',
      email: 'john@example.com',
      phone: '5551234567',
      hourlyRate: 25,
      bio: 'Experienced caregiver with 5 years in senior care. I specialize in dementia care and mobility assistance.',
      skills: ['Driving', 'Meal Preparation'],
      certifications: ['CPR', 'First Aid'],
      backgroundCheckData: {
        legalFirstName: 'John',
        legalLastName: 'Doe',
        dob: '1990-01-15',
        ssn: '123456789',
        address: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        zip: '62701',
        consentGiven: true
      },
      hasTransportation: true,
      isSmoker: false,
      gender: 'Male',
      experience: 5,
      acceptsMicroVisits: true
    };

    it('should validate complete caregiver data', () => {
      const result = caregiverSignupSchema.parse(validCaregiver);
      expect(result.name).toBe('John Doe');
      expect(result.hourlyRate).toBe(25);
    });

    it('should reject short bio', () => {
      const invalid = { ...validCaregiver, bio: 'Short bio' };
      expect(() => caregiverSignupSchema.parse(invalid)).toThrow();
    });

    it('should reject invalid hourly rate', () => {
      const invalid = { ...validCaregiver, hourlyRate: 5 };
      expect(() => caregiverSignupSchema.parse(invalid)).toThrow();
    });

    it('should reject missing background check consent', () => {
      const invalid = {
        ...validCaregiver,
        backgroundCheckData: { ...validCaregiver.backgroundCheckData, consentGiven: false }
      };
      expect(() => caregiverSignupSchema.parse(invalid)).toThrow();
    });

    it('should reject extra fields in strict mode', () => {
      const invalid = { ...validCaregiver, hackerField: 'malicious_data' };
      expect(() => caregiverSignupSchema.parse(invalid)).toThrow();
    });
  });

  describe('seniorSchema', () => {
    const validSenior = {
      name: 'Jane Smith',
      age: 75,
      location: '123 Oak St, Springfield, IL',
      zipCode: '62701',
      needs: ['Mobility Support', 'Medication Reminders'],
      personality: 'Introvert',
      phone: '5559876543'
    };

    it('should validate complete senior profile', () => {
      const result = seniorSchema.parse(validSenior);
      expect(result.name).toBe('Jane Smith');
      expect(result.age).toBe(75);
    });

    it('should reject invalid age', () => {
      const invalid = { ...validSenior, age: 150 };
      expect(() => seniorSchema.parse(invalid)).toThrow();
    });

    it('should accept optional fields', () => {
      const minimal = {
        name: 'Jane Smith',
        age: 75,
        location: 'Springfield, IL',
        zipCode: '62701',
        needs: ['Companionship'],
        personality: 'Ambivert'
      };
      expect(() => seniorSchema.parse(minimal)).not.toThrow();
    });
  });

  describe('appointmentSchema', () => {
    const validAppointment = {
      clientId: 'client123',
      caregiverId: 'caregiver456',
      caregiverName: 'John Doe',
      clientName: 'Jane Smith',
      date: '2026-02-15',
      time: '14:00',
      cost: 150
    };

    it('should validate appointment', () => {
      const result = appointmentSchema.parse(validAppointment);
      expect(result.cost).toBe(150);
    });

    it('should reject invalid date format', () => {
      const invalid = { ...validAppointment, date: '02-15-2026' };
      expect(() => appointmentSchema.parse(invalid)).toThrow();
    });

    it('should reject invalid time format', () => {
      const invalid = { ...validAppointment, time: '2:00 PM' };
      expect(() => appointmentSchema.parse(invalid)).toThrow();
    });
  });

  describe('messageSchema', () => {
    it('should validate message', () => {
      const result = messageSchema.parse({
        text: 'Hello, when can you start?',
        senderId: 'user123'
      });
      expect(result.text).toBe('Hello, when can you start?');
    });

    it('should reject empty messages', () => {
      expect(() => messageSchema.parse({ text: '', senderId: 'user123' })).toThrow();
    });

    it('should reject overly long messages', () => {
      const longText = 'a'.repeat(2001);
      expect(() => messageSchema.parse({ text: longText, senderId: 'user123' })).toThrow();
    });
  });

  describe('validate helper', () => {
    it('should return valid data', () => {
      const data = { email: 'test@example.com' };
      const result = validate(emailSchema, data.email);
      expect(result).toBe('test@example.com');
    });

    it('should throw formatted error', () => {
      expect(() => validate(emailSchema, 'invalid')).toThrow('Validation failed');
    });
  });

  describe('validateSafe helper', () => {
    it('should return success for valid data', () => {
      const result = validateSafe(emailSchema, 'test@example.com');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('test@example.com');
      }
    });

    it('should return error for invalid data', () => {
      const result = validateSafe(emailSchema, 'invalid');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect((result as any).error).toContain('email');
      }
    });
  });

  describe('sanitizeString', () => {
    it('should remove HTML tags', () => {
      // Removes angle brackets but keeps content (safe)
      expect(sanitizeString('<script>alert("xss")</script>')).toBe('scriptalert("xss")/script');
      // Also removes onerror= as it's an event handler pattern
      expect(sanitizeString('<img src=x onerror=alert(1)>')).toBe('img src=x alert(1)');
    });

    it('should remove javascript protocol', () => {
      expect(sanitizeString('javascript:alert(1)')).toBe('alert(1)');
    });

    it('should remove event handlers', () => {
      // Removes the onclick= part (on\w+= pattern)
      expect(sanitizeString('onclick=alert(1)')).toBe('alert(1)');
    });
  });

  describe('validateImageFile', () => {
    it('should accept valid images', () => {
      const validFile = new File(['test'], 'photo.jpg', { type: 'image/jpeg' });
      const result = validateImageFile(validFile);
      expect(result.valid).toBe(true);
    });

    it('should reject non-images', () => {
      const invalidFile = new File(['test'], 'document.pdf', { type: 'application/pdf' });
      const result = validateImageFile(invalidFile);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Only JPEG');
    });

    it('should reject oversized files', () => {
      const largeFile = new File(['x'.repeat(6 * 1024 * 1024)], 'large.jpg', { type: 'image/jpeg' });
      const result = validateImageFile(largeFile);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('5MB');
    });
  });
});
