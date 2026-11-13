import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

// Wave 1 (2026-11-09): the public job post is created ONLY by the family pressing "Post this job".
// It used to be created automatically the moment identity + membership were done — right after the
// family clicked "Looks good" on their care plan — and nearby care providers were texted with nothing saying so.

const h = vi.hoisted(() => ({
  createJobPost: vi.fn(async (..._args: unknown[]) => ({})),
  existingPosts: [] as unknown[],
  saved: { city: 'Gilroy', state: 'CA', careNeeds: ['Companionship'], rate: 26, jobDescription: 'Loves tea and a walk', street: '1 Secret St' } as Record<string, unknown> | null,
}));

vi.mock('../../hooks/useOnboardingProgress', () => ({
  useOnboardingProgress: () => ({
    carePlanPercent: 100, carePlanHint: 'All set', steps: [], currentStep: 'all-done', completedCount: 3,
    identityVerified: true, membershipActive: true, loading: false,
  }),
}));
vi.mock('../../services/stripeService', () => ({ startIdentityVerification: vi.fn() }));
vi.mock('../../services/api', () => ({ dbService: { createJobPost: h.createJobPost } }));
vi.mock('../../lib/firebase', () => ({
  db: {
    collection: (name: string) => ({
      where: () => ({ limit: () => ({ get: async () => ({ empty: h.existingPosts.length === 0 }) }) }),
      doc: () => ({ get: async () => ({ exists: h.saved !== null, data: () => h.saved }) }),
      __name: name,
    }),
  },
}));

import { WhatsNext } from './WhatsNext';

beforeEach(() => { cleanup(); h.createJobPost.mockClear(); h.existingPosts = []; h.saved = { city: 'Gilroy', state: 'CA', careNeeds: ['Companionship'], rate: 26, jobDescription: 'Loves tea and a walk', street: '1 Secret St' }; });

describe('WhatsNext — posting the job is an explicit step', () => {
  it('shows what will be shared and creates NOTHING until "Post this job" is pressed', async () => {
    render(<WhatsNext uid="fam1" displayName="Hamse Y" onNavigate={() => {}} />);
    expect(await screen.findByText("Your job isn't posted yet")).toBeTruthy();
    expect(screen.getByText(/they get a text and a notification/i)).toBeTruthy();
    expect(screen.getByText('Gilroy, CA')).toBeTruthy();
    expect(screen.queryByText(/1 Secret St/)).toBeNull(); // the street is never shown
    await new Promise((r) => setTimeout(r, 30));
    expect(h.createJobPost).not.toHaveBeenCalled(); // no automatic post
  });

  it('pressing "Post this job" creates the post once and confirms it', async () => {
    render(<WhatsNext uid="fam1" displayName="Hamse Y" onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Post this job' }));
    await waitFor(() => expect(h.createJobPost).toHaveBeenCalledTimes(1));
    expect(h.createJobPost.mock.calls[0][1]).toBe('fam1');
    expect(await screen.findByText(/Your job is posted/)).toBeTruthy();
  });

  it('"Not yet" hides the card and posts nothing', async () => {
    render(<WhatsNext uid="fam1" displayName="Hamse Y" onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not yet' }));
    expect(screen.queryByText("Your job isn't posted yet")).toBeNull();
    expect(h.createJobPost).not.toHaveBeenCalled();
  });

  it('offers nothing when a post already exists', async () => {
    h.existingPosts = [{ id: 'p1' }];
    render(<WhatsNext uid="fam1" displayName="Hamse Y" onNavigate={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Your job isn't posted yet")).toBeNull();
    expect(h.createJobPost).not.toHaveBeenCalled();
  });
});
