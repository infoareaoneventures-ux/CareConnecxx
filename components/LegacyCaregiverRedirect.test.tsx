import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { LegacyCaregiverRedirect, LegacyClientCaregiverRedirect, legacyCaregiverPathToCareProvider, legacyClientPathToCareProvider } from './LegacyCaregiverRedirect';

// The caregiver pages moved to /care-provider/… (2026-10-12). Every address
// Evia texted or a bell wrote before that must still land on the same page.
const ShowLocation: React.FC = () => {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search + l.hash}</div>;
};

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/caregiver" element={<LegacyCaregiverRedirect />} />
        <Route path="/caregiver/*" element={<LegacyCaregiverRedirect />} />
        <Route path="/care-provider/*" element={<ShowLocation />} />
        <Route path="/client/find-caregivers" element={<LegacyClientCaregiverRedirect />} />
        <Route path="/client/caregiver" element={<LegacyClientCaregiverRedirect />} />
        <Route path="/client/caregiver/*" element={<LegacyClientCaregiverRedirect />} />
        <Route path="/client/find-care-providers" element={<ShowLocation />} />
        <Route path="/client/care-provider/*" element={<ShowLocation />} />
        <Route path="*" element={<div data-testid="loc">404</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('LegacyCaregiverRedirect — /caregiver/* → /care-provider/*', () => {
  it.each([
    ['/caregiver/dashboard', '/care-provider/dashboard'],
    ['/caregiver/jobs?tab=interviews', '/care-provider/jobs?tab=interviews'],
    ['/caregiver/bookings?tab=active&visit=s1', '/care-provider/bookings?tab=active&visit=s1'],
    ['/caregiver/payments?tab=payouts&stripe=success', '/care-provider/payments?tab=payouts&stripe=success'],
    ['/caregiver/profile?section=reviews#top', '/care-provider/profile?section=reviews#top'],
    ['/caregiver/inbox?client=c1', '/care-provider/inbox?client=c1'],
    ['/caregiver/abc123', '/care-provider/abc123'],
    ['/caregiver', '/care-provider'],
  ])('%s → %s', (from, to) => {
    renderAt(from);
    expect(screen.getByTestId('loc').textContent).toBe(to);
  });

  it('the pure helper keeps the sub-path, query string and hash', () => {
    expect(legacyCaregiverPathToCareProvider('/caregiver/settings', '?x=1', '#y')).toBe('/care-provider/settings?x=1#y');
    expect(legacyCaregiverPathToCareProvider('/caregiver')).toBe('/care-provider');
  });
});

// The family's two provider addresses moved the same day: /client/find-caregivers
// → /client/find-care-providers, /client/caregiver/:id → /client/care-provider/:id.
describe('LegacyClientCaregiverRedirect — the family-side addresses', () => {
  it.each([
    ['/client/find-caregivers', '/client/find-care-providers'],
    ['/client/find-caregivers?q=dementia#results', '/client/find-care-providers?q=dementia#results'],
    ['/client/caregiver/cg1', '/client/care-provider/cg1'],
    ['/client/caregiver/cg1?review=1', '/client/care-provider/cg1?review=1'],
    ['/client/caregiver/cg1?review=1&from=bell#reviews', '/client/care-provider/cg1?review=1&from=bell#reviews'],
    ['/client/caregiver', '/client/care-provider'],
  ])('%s → %s', (from, to) => {
    renderAt(from);
    expect(screen.getByTestId('loc').textContent).toBe(to);
  });

  it('the pure helper keeps the id, query string and hash, and leaves other paths alone', () => {
    expect(legacyClientPathToCareProvider('/client/caregiver/cg1', '?review=1', '#top')).toBe('/client/care-provider/cg1?review=1#top');
    expect(legacyClientPathToCareProvider('/client/find-caregivers', '?x=1')).toBe('/client/find-care-providers?x=1');
    expect(legacyClientPathToCareProvider('/client/find-caregivers/')).toBe('/client/find-care-providers');
    expect(legacyClientPathToCareProvider('/client/caregivers-list')).toBe('/client/caregivers-list');
  });
});
