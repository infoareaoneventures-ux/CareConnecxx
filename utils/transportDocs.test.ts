import { describe, it, expect } from 'vitest';
import { hasValidTransportDocs, transportDocsApproved } from './transportDocs';

// The transportation badge families see = all three documents approved AND the
// driving record (MVR) cleared (founder, 2026-09-25). Neither half alone earns it.

const approvedDocs = {
  driversLicense: { status: 'approved', url: 'x' },
  insurance: { status: 'approved', url: 'x' },
  registration: { status: 'approved', url: 'x' },
};

describe('transportDocsApproved', () => {
  it('needs Transportation on the profile and all three documents approved', () => {
    expect(transportDocsApproved({ services: ['Transportation'], documents: approvedDocs })).toBe(true);
    expect(transportDocsApproved({ skills: ['Transportation'], documents: approvedDocs })).toBe(true);
    expect(transportDocsApproved({ services: ['Companionship'], documents: approvedDocs })).toBe(false);
    expect(transportDocsApproved({ services: ['Transportation'], documents: { ...approvedDocs, insurance: { status: 'pending' } } })).toBe(false);
    expect(transportDocsApproved({ services: ['Transportation'], documents: { ...approvedDocs, insurance: { status: 'approved', expirationDate: '2000-01-01' } } })).toBe(false);
  });
});

describe('hasValidTransportDocs (the badge)', () => {
  it('is false with approved documents but no cleared MVR', () => {
    expect(hasValidTransportDocs({ services: ['Transportation'], documents: approvedDocs })).toBe(false);
    expect(hasValidTransportDocs({ services: ['Transportation'], documents: approvedDocs, isApprovedDriver: false })).toBe(false);
  });
  it('is false with a cleared MVR but documents still pending', () => {
    expect(hasValidTransportDocs({ services: ['Transportation'], isApprovedDriver: true, documents: { ...approvedDocs, registration: { status: 'pending' } } })).toBe(false);
  });
  it('is true only when both halves are in', () => {
    expect(hasValidTransportDocs({ services: ['Transportation'], documents: approvedDocs, isApprovedDriver: true })).toBe(true);
  });
  it('trusts the precomputed flag on a public profile copy (no documents there by design)', () => {
    expect(hasValidTransportDocs({ hasValidTransportDocs: true, services: ['Transportation'] })).toBe(true);
    expect(hasValidTransportDocs({ hasValidTransportDocs: false, services: ['Transportation'], documents: approvedDocs, isApprovedDriver: true })).toBe(false);
  });
  it('handles missing profiles', () => {
    expect(hasValidTransportDocs(null)).toBe(false);
    expect(hasValidTransportDocs({})).toBe(false);
  });
});
