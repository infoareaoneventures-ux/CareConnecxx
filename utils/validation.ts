/**
 * Input Validation Utilities
 * Runtime validation for API inputs and form data
 */

export class ValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Normalize phone number to E.164 format
 * - Strips all non-digit characters
 * - Adds +1 prefix for US numbers if not present
 * - Returns null if invalid
 */
export function normalizePhoneNumber(phone: string): string | null {
  if (!phone) return null;
  
  // Strip all non-digits
  const digits = phone.replace(/\D/g, '');
  
  // US number: 10 digits, add +1 prefix
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  // Already has country code (11 digits starting with 1)
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  // International format with + already present in original
  if (digits.length > 10) {
    return `+${digits}`;
  }
  
  return null;
}

/**
 * Format phone number for display (US format: (555) 123-4567)
 */
export function formatPhoneDisplay(phone: string): string {
  if (!phone) return '';
  
  // Strip all non-digits
  const digits = phone.replace(/\D/g, '');
  
  // Handle US numbers
  const usDigits = digits.length === 11 && digits.startsWith('1') 
    ? digits.slice(1) 
    : digits;
    
  if (usDigits.length === 10) {
    return `(${usDigits.slice(0, 3)}) ${usDigits.slice(3, 6)}-${usDigits.slice(6)}`;
  }
  
  return phone;
}

export const validators = {
  /**
   * Hash a value for logging (HIPAA compliance)
   */
  hashForLogging: async (value: string): Promise<string> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
  },

  /**
   * Validate password strength
   */
  password: (value: string): string | null => {
    if (!value || value.length < 8) {
      return 'Password must be at least 8 characters';
    }
    if (!/[A-Z]/.test(value)) {
      return 'Password must contain at least one uppercase letter';
    }
    if (!/[a-z]/.test(value)) {
      return 'Password must contain at least one lowercase letter';
    }
    if (!/[0-9]/.test(value)) {
      return 'Password must contain at least one number';
    }
    return null;
  },

  /**
   * Validate phone number (E.164 format)
   */
  phone: (value: string): string | null => {
    const normalized = normalizePhoneNumber(value);
    if (!normalized) {
      return 'Phone number must be 10 digits';
    }
    return null;
  },

  /**
   * Validate SSN format and check for invalid/placeholder SSNs
   */
  ssn: (value: string): string | null => {
    const ssnRegex = /^\d{3}-?\d{2}-?\d{4}$/;
    if (!ssnRegex.test(value)) {
      return 'Invalid SSN format (use XXX-XX-XXXX)';
    }
    
    // Normalize to check for invalid SSNs
    const normalized = value.replace(/-/g, '');
    const area = normalized.substring(0, 3);
    const group = normalized.substring(3, 5);
    const serial = normalized.substring(5, 9);
    
    // Check for explicitly invalid SSNs
    const invalidSSNs = [
      '000000000', '111111111', '222222222', '333333333', '444444444',
      '555555555', '666666666', '777777777', '888888888', '999999999',
      '123456789', '987654321', '111223333', '000120000'
    ];
    if (invalidSSNs.includes(normalized)) {
      return 'Invalid SSN: This is a known invalid or test SSN';
    }
    
    // Check area number (first 3 digits)
    // Area 000, 666, and 900-999 are invalid
    const areaNum = parseInt(area, 10);
    if (area === '000' || area === '666' || areaNum >= 900) {
      return 'Invalid SSN: Invalid area number';
    }
    
    // Check group number (middle 2 digits) - 00 is invalid
    if (group === '00') {
      return 'Invalid SSN: Invalid group number';
    }
    
    // Check serial number (last 4 digits) - 0000 is invalid
    if (serial === '0000') {
      return 'Invalid SSN: Invalid serial number';
    }
    
    return null;
  },

  /**
   * Validate a string is non-empty
   */
  string: (value: any, fieldName: string, options?: { min?: number; max?: number; pattern?: RegExp }): string => {
    if (typeof value !== 'string') {
      throw new ValidationError(`${fieldName} must be a string`, fieldName);
    }
    if (value.trim().length === 0) {
      throw new ValidationError(`${fieldName} cannot be empty`, fieldName);
    }
    if (options?.min !== undefined && value.length < options.min) {
      throw new ValidationError(`${fieldName} must be at least ${options.min} characters`, fieldName);
    }
    if (options?.max !== undefined && value.length > options.max) {
      throw new ValidationError(`${fieldName} must be at most ${options.max} characters`, fieldName);
    }
    if (options?.pattern && !options.pattern.test(value)) {
      throw new ValidationError(`${fieldName} format is invalid`, fieldName);
    }
    return value.trim();
  },

  /**
   * Validate an email address
   */
  email: (value: any, fieldName: string = 'email'): string => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return validators.string(value, fieldName, { pattern: emailRegex });
  },

  /**
   * Validate a UUID or document ID
   */
  id: (value: any, fieldName: string = 'id'): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ValidationError(`${fieldName} must be a valid identifier`, fieldName);
    }
    return value.trim();
  },

  /**
   * Validate a number
   */
  number: (value: any, fieldName: string, options?: { min?: number; max?: number; integer?: boolean }): number => {
    const num = Number(value);
    if (isNaN(num)) {
      throw new ValidationError(`${fieldName} must be a number`, fieldName);
    }
    if (options?.integer && !Number.isInteger(num)) {
      throw new ValidationError(`${fieldName} must be an integer`, fieldName);
    }
    if (options?.min !== undefined && num < options.min) {
      throw new ValidationError(`${fieldName} must be at least ${options.min}`, fieldName);
    }
    if (options?.max !== undefined && num > options.max) {
      throw new ValidationError(`${fieldName} must be at most ${options.max}`, fieldName);
    }
    return num;
  },

  /**
   * Validate a date string
   */
  date: (value: any, fieldName: string = 'date'): string => {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      throw new ValidationError(`${fieldName} must be a valid date`, fieldName);
    }
    return value;
  },

  /**
   * Validate an array
   */
  array: <T>(value: any, fieldName: string, itemValidator?: (item: any, index: number) => T): T[] => {
    if (!Array.isArray(value)) {
      throw new ValidationError(`${fieldName} must be an array`, fieldName);
    }
    if (itemValidator) {
      return value.map((item, index) => {
        try {
          return itemValidator(item, index);
        } catch (err) {
          if (err instanceof ValidationError) {
            throw new ValidationError(`${fieldName}[${index}]: ${err.message}`, `${fieldName}[${index}]`);
          }
          throw err;
        }
      });
    }
    return value;
  },

  /**
   * Validate an object has required fields
   */
  object: (value: any, fieldName: string, requiredFields?: string[]): Record<string, any> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ValidationError(`${fieldName} must be an object`, fieldName);
    }
    if (requiredFields) {
      for (const field of requiredFields) {
        if (!(field in value) || value[field] === undefined || value[field] === null) {
          throw new ValidationError(`${fieldName}.${field} is required`, `${fieldName}.${field}`);
        }
      }
    }
    return value;
  },

  /**
   * Validate a value is one of allowed enum values
   */
  enum: <T extends string>(value: any, fieldName: string, allowedValues: T[]): T => {
    if (!allowedValues.includes(value)) {
      throw new ValidationError(
        `${fieldName} must be one of: ${allowedValues.join(', ')}`,
        fieldName
      );
    }
    return value;
  }
};

/**
 * Validate US zip code (5 digits)
 * Returns validation result with error message if invalid
 */
export function validateZipCode(zipCode: string): { valid: boolean; error?: string } {
  const trimmed = zipCode.trim();
  
  if (!trimmed) {
    return { valid: false, error: 'Please enter a zip code' };
  }
  
  if (trimmed.length !== 5) {
    return { valid: false, error: 'Zip code must be 5 digits' };
  }
  
  if (!/^\d{5}$/.test(trimmed)) {
    return { valid: false, error: 'Zip code must contain only numbers' };
  }
  
  // Check for invalid zip codes (00000, 99999 are technically valid but unlikely)
  if (trimmed === '00000') {
    return { valid: false, error: 'Invalid zip code' };
  }
  
  return { valid: true };
}

/**
 * Sanitize a string to prevent XSS by removing dangerous content
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers (onclick, onerror, etc.)
    .substring(0, 4000); // Limit length
}

/**
 * Validate and sanitize message text
 */
export function validateMessageText(text: string): string {
  const trimmed = validators.string(text, 'text', { min: 1, max: 2000 });
  return sanitizeString(trimmed);
}

// Add sanitizeString to validators object for api.ts compatibility
(validators as any).sanitizeString = sanitizeString;

export default validators;

// ==========================================
// AUTH VALIDATION HELPERS
// ==========================================

interface ValidationResult {
  isValid: boolean;
  errors: Array<{ field: string; message: string }>;
}

/**
 * Validate login form inputs
 */
export function validateLogin(data: { email: string; password: string }): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];

  if (!data.email || !data.email.trim()) {
    errors.push({ field: 'email', message: 'Email is required' });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.push({ field: 'email', message: 'Invalid email format' });
  }

  if (!data.password || data.password.length < 6) {
    errors.push({ field: 'password', message: 'Password must be at least 6 characters' });
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validate signup form inputs
 */
export function validateSignup(data: {
  email: string;
  password: string;
  name: string;
  userType: string;
  [key: string]: any;
}): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];

  if (!data.email || !data.email.trim()) {
    errors.push({ field: 'email', message: 'Email is required' });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.push({ field: 'email', message: 'Invalid email format' });
  }

  // Use same validation as validators.password (uppercase, lowercase, number)
  const passwordError = validators.password(data.password);
  if (passwordError) {
    errors.push({ field: 'password', message: passwordError });
  }

  if (!data.name || !data.name.trim()) {
    errors.push({ field: 'name', message: 'Name is required' });
  }

  if (!data.userType || !['client', 'caregiver'].includes(data.userType)) {
    errors.push({ field: 'userType', message: 'Invalid user type' });
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Check if error is a Firebase error
 */
export function isFirebaseError(error: unknown): error is { code: string; message: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Get safe error message from Firebase or other errors
 */
export function getSafeErrorMessage(error: unknown): string {
  if (isFirebaseError(error)) {
    switch (error.code) {
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        return 'Invalid email or password';
      case 'auth/email-already-in-use':
        return 'Email already registered';
      case 'auth/invalid-email':
        return 'Invalid email format';
      case 'auth/weak-password':
        return 'Password is too weak';
      case 'auth/too-many-requests':
        return 'Too many attempts. Please try again later.';
      case 'permission-denied':
        return 'Access denied. Please check your permissions.';
      default:
        return 'An error occurred. Please try again.';
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unknown error occurred';
}

// ==========================================
// SCHEMA VALIDATION SYSTEM (For Tests)
// ==========================================

interface Schema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

class StringSchema implements Schema<string> {
  private validators: Array<(value: string) => void> = [];
  private transformFns: Array<(value: string) => string> = [];

  email(): this {
    this.validators.push((value) => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        throw new Error('Invalid email format');
      }
    });
    return this;
  }

  regex(pattern: RegExp, message?: string): this {
    this.validators.push((value) => {
      if (!pattern.test(value)) {
        throw new Error(message || `Value does not match required pattern`);
      }
    });
    return this;
  }

  min(length: number): this {
    this.validators.push((value) => {
      if (value.length < length) {
        throw new Error(`String must be at least ${length} characters`);
      }
    });
    return this;
  }

  max(length: number): this {
    this.validators.push((value) => {
      if (value.length > length) {
        throw new Error(`String must be at most ${length} characters`);
      }
    });
    return this;
  }

  transform(fn: (value: string) => string): this {
    this.transformFns.push(fn);
    return this;
  }

  parse(value: unknown): string {
    if (typeof value !== 'string') {
      throw new Error('Value must be a string');
    }
    
    // Apply all transforms in sequence
    let transformed = value;
    for (const fn of this.transformFns) {
      transformed = fn(transformed);
    }
    
    // Run validators
    for (const validator of this.validators) {
      validator(transformed);
    }
    
    return transformed;
  }

  safeParse(value: unknown): { success: true; data: string } | { success: false; error: { message: string } } {
    try {
      const data = this.parse(value);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: { message: (error as Error).message } };
    }
  }
}

class NumberSchema implements Schema<number> {
  private minVal?: number;
  private maxVal?: number;

  min(value: number): this {
    this.minVal = value;
    return this;
  }

  max(value: number): this {
    this.maxVal = value;
    return this;
  }

  parse(value: unknown): number {
    const num = Number(value);
    if (isNaN(num)) {
      throw new Error('Value must be a number');
    }
    if (this.minVal !== undefined && num < this.minVal) {
      throw new Error(`Number must be at least ${this.minVal}`);
    }
    if (this.maxVal !== undefined && num > this.maxVal) {
      throw new Error(`Number must be at most ${this.maxVal}`);
    }
    return num;
  }

  safeParse(value: unknown): { success: true; data: number } | { success: false; error: { message: string } } {
    try {
      const data = this.parse(value);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: { message: (error as Error).message } };
    }
  }
}

class ArraySchema<T> implements Schema<T[]> {
  constructor(private itemSchema?: Schema<T>) {}

  parse(value: unknown): T[] {
    if (!Array.isArray(value)) {
      throw new Error('Value must be an array');
    }
    if (this.itemSchema) {
      return value.map(item => this.itemSchema!.parse(item));
    }
    return value as T[];
  }

  safeParse(value: unknown): { success: true; data: T[] } | { success: false; error: { message: string } } {
    try {
      const data = this.parse(value);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: { message: (error as Error).message } };
    }
  }
}

class ObjectSchema<T extends Record<string, any>> implements Schema<T> {
  private shape: Record<string, Schema<any>>;
  private strictMode = false;

  constructor(shape: Record<string, Schema<any>>) {
    this.shape = shape;
  }

  strict(): this {
    this.strictMode = true;
    return this;
  }

  parse(value: unknown): T {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Value must be an object');
    }

    const obj = value as Record<string, any>;
    const result: Record<string, any> = {};

    // Check for extra fields in strict mode
    if (this.strictMode) {
      const allowedKeys = Object.keys(this.shape);
      const actualKeys = Object.keys(obj);
      const extraKeys = actualKeys.filter(key => !allowedKeys.includes(key));
      if (extraKeys.length > 0) {
        throw new Error(`Unexpected fields: ${extraKeys.join(', ')}`);
      }
    }

    for (const [key, schema] of Object.entries(this.shape)) {
      if (key in obj) {
        try {
          result[key] = schema.parse(obj[key]);
        } catch (error) {
          throw new Error(`${key}: ${(error as Error).message}`);
        }
      }
    }

    return result as T;
  }

  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } {
    try {
      const data = this.parse(value);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: { message: (error as Error).message } };
    }
  }
}

// Schema factory functions
export function string(): StringSchema {
  return new StringSchema();
}

export function number(): NumberSchema {
  return new NumberSchema();
}

export function array<T>(itemSchema?: Schema<T>): ArraySchema<T> {
  return new ArraySchema(itemSchema);
}

export function object<T extends Record<string, any>>(shape: Record<string, Schema<any>>): ObjectSchema<T> {
  return new ObjectSchema<T>(shape);
}

// ==========================================
// PREDEFINED SCHEMAS
// ==========================================

export const emailSchema = string()
  .email()
  .min(6) // Reject short emails like a@b.c
  .transform(v => v.toLowerCase());

export const phoneSchema = string()
  .regex(/^\d{10}$/, 'Phone must be 10 digits')
  .transform(v => v.replace(/\D/g, ''));

export const ssnSchema = string()
  .transform(v => v.replace(/-/g, ''))
  .regex(/^\d{9}$/, 'SSN must be 9 digits')
  .transform(v => {
    // Check for invalid SSNs (all same digit is invalid)
    const invalidSSNs = [
      '000000000', '111111111', '222222222', '333333333', '444444444',
      '555555555', '666666666', '777777777', '888888888', '999999999'
    ];
    if (invalidSSNs.includes(v)) {
      throw new Error('Invalid SSN');
    }
    // Check SSN format rules
    const area = v.substring(0, 3);
    const group = v.substring(3, 5);
    const serial = v.substring(5, 9);
    if (area === '000' || area === '666' || parseInt(area) >= 900) {
      throw new Error('Invalid SSN area number');
    }
    if (group === '00') {
      throw new Error('Invalid SSN group number');
    }
    if (serial === '0000') {
      throw new Error('Invalid SSN serial number');
    }
    return v;
  });

export const zipCodeSchema = string()
  .regex(/^\d{5}(-\d{4})?$/, 'Invalid ZIP code format');

class BooleanSchema implements Schema<boolean> {
  parse(value: unknown): boolean {
    if (typeof value !== 'boolean') {
      throw new Error('Value must be a boolean');
    }
    return value;
  }
  safeParse(value: unknown): { success: true; data: boolean } | { success: false; error: { message: string } } {
    try {
      return { success: true, data: this.parse(value) };
    } catch (e) {
      return { success: false, error: { message: (e as Error).message } };
    }
  }
}

export function boolean(): BooleanSchema {
  return new BooleanSchema();
}

class TrueBooleanSchema implements Schema<true> {
  parse(value: unknown): true {
    if (value !== true) {
      throw new Error('Value must be true');
    }
    return true;
  }
  safeParse(value: unknown): { success: true; data: true } | { success: false; error: { message: string } } {
    try {
      return { success: true, data: this.parse(value) };
    } catch (e) {
      return { success: false, error: { message: (e as Error).message } };
    }
  }
}

export function trueBoolean(): TrueBooleanSchema {
  return new TrueBooleanSchema();
}

export const caregiverSignupSchema = object({
  name: string().min(2),
  email: emailSchema,
  phone: phoneSchema,
  hourlyRate: number().min(15).max(200),
  bio: string().min(50),
  skills: array(string()),
  certifications: array(string()),
  backgroundCheckData: object({
    legalFirstName: string(),
    legalLastName: string(),
    dob: string(),
    ssn: ssnSchema,
    address: string(),
    city: string(),
    state: string(),
    zip: zipCodeSchema,
    consentGiven: trueBoolean()
  }),
  hasTransportation: boolean(),
  isSmoker: boolean(),
  gender: string(),
  experience: number().min(0),
  acceptsMicroVisits: boolean()
}).strict();

export const seniorSchema = object({
  name: string().min(2),
  age: number().min(50).max(120),
  location: string(),
  zipCode: zipCodeSchema,
  needs: array(string()),
  personality: string(),
  phone: phoneSchema
});

export const appointmentSchema = object({
  clientId: string(),
  caregiverId: string(),
  caregiverName: string(),
  clientName: string(),
  date: string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  time: string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM'),
  cost: number().min(0)
});

export const messageSchema = object({
  text: string().min(1).max(2000),
  senderId: string()
});

// ==========================================
// VALIDATION HELPERS
// ==========================================

export function validate<T>(schema: Schema<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new Error('Validation failed');
  }
}

export function validateSafe<T>(schema: Schema<T>, value: unknown): 
  | { success: true; data: T }
  | { success: false; error: string } {
  const result = schema.safeParse(value);
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    return { success: false, error: (result as any).error.message };
  }
}

// ==========================================
// IMAGE FILE VALIDATION
// ==========================================

interface ImageValidationResult {
  valid: boolean;
  error?: string;
}

export function validateImageFile(file: File): ImageValidationResult {
  // Check file type
  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!validTypes.includes(file.type)) {
    return { valid: false, error: 'Only JPEG, PNG, GIF, and WebP images are allowed' };
  }

  // Check file size (5MB max)
  const maxSize = 5 * 1024 * 1024; // 5MB in bytes
  if (file.size > maxSize) {
    return { valid: false, error: 'Image must be less than 5MB' };
  }

  return { valid: true };
}
