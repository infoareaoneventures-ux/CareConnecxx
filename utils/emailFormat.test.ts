import { describe, it, expect } from 'vitest';
import { looksLikeEmail, EMAIL_FORMAT_MESSAGE } from './emailFormat';
import { safeErrorMessage } from './safeErrorMessage';

describe('looksLikeEmail', () => {
  it('accepts normal addresses and rejects obvious non-emails', () => {
    expect(looksLikeEmail('maria@example.com')).toBe(true);
    expect(looksLikeEmail(' maria.lopez+evia@mail.example.org ')).toBe(true);
    for (const bad of ['', 'maria', 'maria@', '@example.com', 'maria@example', 'maria @example.com', 'maria@example.c', undefined, 42]) expect(looksLikeEmail(bad)).toBe(false);
  });
});

describe('account-change errors say what went wrong', () => {
  it('the server\'s own reason reaches the person; infrastructure noise does not', () => {
    expect(safeErrorMessage(new Error('Valid email required'), 'Failed to send the link')).toBe('Valid email required');
    expect(safeErrorMessage(new Error('That email address was rejected by the mail service'), 'Failed to send the link')).toMatch(/rejected/);
    expect(safeErrorMessage(new Error('FirebaseError: Missing or insufficient permissions'), 'Failed to send the link')).toBe('Failed to send the link');
    expect(EMAIL_FORMAT_MESSAGE).toMatch(/valid email/i);
  });
});
