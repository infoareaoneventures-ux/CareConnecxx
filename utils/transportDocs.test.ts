import { describe, it, expect } from 'vitest';
import { hasValidTransportDocs, offersTransportation, drivingJobsHiddenFor, jobIncludesDriving } from './transportDocs';

// Transportation = offered on the profile + driving record cleared. No documents (founder, 2026-10-06).
describe('hasValidTransportDocs (Transportation live)', () => {
  it('needs Transportation on the profile and a cleared driving record', () => {
    expect(hasValidTransportDocs({ services: ['Transportation'], isApprovedDriver: true })).toBe(true);
    expect(hasValidTransportDocs({ skills: ['Transportation'], isApprovedDriver: true })).toBe(true);
    expect(hasValidTransportDocs({ services: ['Transportation'], isApprovedDriver: false })).toBe(false);
    expect(hasValidTransportDocs({ services: ['Companionship'], isApprovedDriver: true })).toBe(false);
  });
  it('trusts the precomputed flag on a public profile copy', () => {
    expect(hasValidTransportDocs({ hasValidTransportDocs: true })).toBe(true);
    expect(hasValidTransportDocs({ hasValidTransportDocs: false, services: ['Transportation'], isApprovedDriver: true })).toBe(false);
  });
  it('handles missing profiles', () => {
    expect(hasValidTransportDocs(null)).toBe(false);
    expect(hasValidTransportDocs(undefined)).toBe(false);
    expect(offersTransportation(null)).toBe(false);
  });
});

describe('driving jobs hidden for a Not approved driving record (founder, 2026-10-05)', () => {
  it('only the final decision hides them; running, under review or never offered still see them', () => {
    expect(drivingJobsHiddenFor({ mvrStatus: 'not_approved' })).toBe(true);
    expect(drivingJobsHiddenFor({ mvrStatus: 'consider' })).toBe(false);
    expect(drivingJobsHiddenFor({ mvrStatus: 'pending' })).toBe(false);
    expect(drivingJobsHiddenFor({})).toBe(false);
    expect(drivingJobsHiddenFor(null)).toBe(false);
  });
  it('a job includes driving when it lists Transportation or requires Driving', () => {
    expect(jobIncludesDriving({ careTypes: ['Transportation'] })).toBe(true);
    expect(jobIncludesDriving({ requirements: ['Driving'] })).toBe(true);
    expect(jobIncludesDriving({ careTypes: ['Companionship'] })).toBe(false);
  });
});
