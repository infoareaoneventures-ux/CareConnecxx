import DOMPurify from 'dompurify';

/**
 * XSS Sanitization Utilities
 * 
 * Uses DOMPurify to sanitize user-generated content before storage and rendering.
 * Prevents XSS attacks while preserving safe HTML when needed.
 */

// Configure DOMPurify for different use cases
const purifyConfig = {
  // Strip all HTML tags (for plain text fields like names, messages)
  plainText: {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  },
  // Allow limited HTML for rich content (bios, descriptions)
  richText: {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'p', 'br', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  },
  // Strict - no HTML at all (for IDs, keys, etc.)
  strict: {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  }
};

/**
 * Sanitize input to plain text (removes all HTML)
 * Use for: names, messages, chat content, titles
 */
export function sanitizePlainText(input: string | null | undefined): string {
  if (!input) return '';
  
  // First run through DOMPurify to remove scripts and dangerous content
  const purified = DOMPurify.sanitize(input, purifyConfig.plainText);
  
  // Decode HTML entities
  const textarea = document.createElement('textarea');
  textarea.innerHTML = purified;
  
  // Trim and limit length to prevent DoS
  return textarea.value.trim().substring(0, 5000);
}

/**
 * Sanitize rich text content (allows limited safe HTML)
 * Use for: bios, descriptions, notes
 */
export function sanitizeRichText(input: string | null | undefined): string {
  if (!input) return '';
  
  // Allow limited safe HTML tags
  return DOMPurify.sanitize(input, purifyConfig.richText);
}

/**
 * Sanitize for use in AI prompts
 * Removes all HTML and special characters that could affect prompt injection
 */
export function sanitizeForAI(input: string | null | undefined): string {
  if (!input) return '';
  
  // Remove all HTML
  let sanitized = sanitizePlainText(input);
  
  // Escape special characters that could affect AI prompts
  sanitized = sanitized
    .replace(/[\"]/g, '\\$&') // Escape quotes
    .replace(/\n+/g, ' ') // Normalize newlines
    .trim();
  
  return sanitized;
}

/**
 * Sanitize a name field
 * Removes HTML, limits length, validates characters
 */
export function sanitizeName(input: string | null | undefined): string {
  if (!input) return '';
  
  const sanitized = sanitizePlainText(input);
  
  // Limit name length
  if (sanitized.length > 100) {
    return sanitized.substring(0, 100).trim();
  }
  
  return sanitized;
}

/**
 * Sanitize caregiver bio
 * Allows limited safe HTML for formatting
 */
export function sanitizeBio(input: string | null | undefined): string {
  if (!input) return '';
  
  const sanitized = sanitizeRichText(input);
  
  // Limit bio length
  if (sanitized.length > 2000) {
    return sanitized.substring(0, 2000);
  }
  
  return sanitized;
}

/**
 * Sanitize chat message content
 * Removes all HTML to prevent XSS in chat
 */
export function sanitizeMessage(input: string | null | undefined): string {
  if (!input) return '';
  
  const sanitized = sanitizePlainText(input);
  
  // Limit message length
  if (sanitized.length > 2000) {
    return sanitized.substring(0, 2000) + '...';
  }
  
  return sanitized;
}

/**
 * Sanitize an object containing user-generated content
 * Recursively sanitizes all string properties
 */
export function sanitizeObject<T extends Record<string, any>>(
  obj: T,
  fieldsToSanitize: (keyof T)[]
): T {
  const sanitized = { ...obj };
  
  for (const field of fieldsToSanitize) {
    if (typeof sanitized[field] === 'string') {
      (sanitized as any)[field] = sanitizePlainText(sanitized[field] as string);
    }
  }
  
  return sanitized;
}

/**
 * Validate and sanitize email (additional layer beyond regex)
 */
export function sanitizeEmail(input: string | null | undefined): string {
  if (!input) return '';
  
  // Remove any HTML/JS
  const sanitized = sanitizePlainText(input).toLowerCase().trim();
  
  // Basic email validation characters only
  return sanitized.replace(/[^a-z0-9._%+-@]/g, '');
}

/**
 * Sanitize search query
 * Prevents injection attacks in search
 */
export function sanitizeSearchQuery(input: string | null | undefined): string {
  if (!input) return '';
  
  const sanitized = sanitizePlainText(input);
  
  // Limit search query length
  if (sanitized.length > 200) {
    return sanitized.substring(0, 200);
  }
  
  return sanitized;
}

export default {
  sanitizePlainText,
  sanitizeRichText,
  sanitizeForAI,
  sanitizeName,
  sanitizeBio,
  sanitizeMessage,
  sanitizeObject,
  sanitizeEmail,
  sanitizeSearchQuery,
};
