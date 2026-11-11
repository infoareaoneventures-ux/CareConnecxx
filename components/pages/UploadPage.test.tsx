import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import React from 'react';

vi.mock('../../lib/firebase', () => ({ functions: { httpsCallable: () => async () => ({}) }, auth: null, db: null, storage: null }));
vi.mock('../../lib/eviaPhone', () => ({ eviaPhoneNow: () => '+14085550100', useEviaPhone: () => '+14085550100' }));

import UploadPage, { hasUploadToken } from './UploadPage';

describe('hasUploadToken', () => {
  it('needs a non-empty ?t= token', () => {
    expect(hasUploadToken('?t=abc123')).toBe(true);
    expect(hasUploadToken('?t=')).toBe(false);
    expect(hasUploadToken('?t=%20')).toBe(false);
    expect(hasUploadToken('')).toBe(false);
  });
});

describe('the photo upload page without its personal link', () => {
  it('shows "This link has expired" with a way to get a new one, not the upload form', () => {
    window.history.pushState({}, '', '/upload/photo');
    render(<MemoryRouter initialEntries={['/upload/photo']}><Routes><Route path="/upload/:type" element={<UploadPage />} /></Routes></MemoryRouter>);
    expect(screen.getByText('This link has expired')).toBeTruthy();
    expect(screen.getByText('Text Evia for a new link')).toBeTruthy();
  });
});
