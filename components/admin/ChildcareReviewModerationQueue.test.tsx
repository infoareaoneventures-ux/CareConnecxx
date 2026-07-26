import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  list: vi.fn(),
  moderate: vi.fn(),
  onAuthStateChanged: vi.fn(() => () => undefined),
}));

vi.mock('../../services/api', () => ({
  adminService: {
    listChildcareReviewModerationQueue: hoisted.list,
    moderateChildcareReview: hoisted.moderate,
  },
}));
vi.mock('../../lib/firebase', () => ({
  auth: {
    currentUser: { uid: 'operator-1' },
    onAuthStateChanged: hoisted.onAuthStateChanged,
  },
}));

import { ChildcareReviewModerationQueue } from './ChildcareReviewModerationQueue';

const ROW = {
  reviewId: 'crev_review1',
  bookingId: 'booking-1',
  caregiverId: 'caregiver-1',
  reviewerRole: 'family' as const,
  rating: 5,
  comment: 'Attentive and reliable',
  createdAt: '2026-07-25T00:00:00.000Z',
  stateVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.list.mockResolvedValue({ rows: [ROW], nextCursor: null });
  hoisted.moderate.mockResolvedValue({
    moderationState: 'published',
    stateVersion: 2,
    replayed: false,
  });
});

describe('ChildcareReviewModerationQueue', () => {
  it('loads only through the server queue and publishes with the exact CAS payload', async () => {
    render(<ChildcareReviewModerationQueue />);
    expect(await screen.findByText('Attentive and reliable')).toBeTruthy();
    expect(hoisted.list).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByRole('button', { name: /Publish/ }));
    expect((await screen.findByLabelText('Public comment') as HTMLTextAreaElement).value)
      .toBe('Attentive and reliable');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm decision' }));
    });

    expect(hoisted.moderate).toHaveBeenCalledWith({
      reviewId: 'crev_review1',
      expectedVersion: 1,
      decision: 'published',
      reasonCode: 'approve_safe',
      publicComment: 'Attentive and reliable',
    });
    await waitFor(() => expect(screen.queryByText('Attentive and reliable')).toBeNull());
  });

  it('refreshes a concurrent decision and keeps the stale-decision warning visible', async () => {
    hoisted.moderate.mockRejectedValueOnce({ code: 'functions/aborted' });
    render(<ChildcareReviewModerationQueue />);
    await screen.findByText('Attentive and reliable');
    fireEvent.click(screen.getByRole('button', { name: /Publish/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm decision' }));
    });
    expect(await screen.findByText(
      'This review changed in another session. The queue was refreshed.',
    )).toBeTruthy();
    expect(hoisted.list).toHaveBeenCalledTimes(2);
  });

  it('offers reauthentication only for the explicit recent-auth error', async () => {
    hoisted.list.mockRejectedValueOnce({
      code: 'functions/failed-precondition',
      details: { code: 'recent_auth_required' },
    });
    render(<ChildcareReviewModerationQueue />);
    expect(await screen.findByRole('button', { name: 'Reauthenticate' })).toBeTruthy();
  });
});
