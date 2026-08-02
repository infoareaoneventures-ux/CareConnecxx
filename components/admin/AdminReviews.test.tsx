import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getAllReviews: vi.fn(),
  deleteReview: vi.fn(),
  listQueue: vi.fn(),
  moderate: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  adminService: {
    getAllReviews: hoisted.getAllReviews,
    deleteReview: hoisted.deleteReview,
    listChildcareReviewModerationQueue: hoisted.listQueue,
    moderateChildcareReview: hoisted.moderate,
  },
}));
vi.mock('../../lib/firebase', () => ({
  auth: {
    currentUser: { uid: 'operator-1' },
    onAuthStateChanged: vi.fn(() => () => undefined),
  },
}));

import { AdminReviews } from './AdminReviews';

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.listQueue.mockResolvedValue({ rows: [], nextCursor: null });
  hoisted.moderate.mockResolvedValue({
    moderationState: 'unpublished',
    stateVersion: 3,
    replayed: false,
  });
  hoisted.getAllReviews.mockResolvedValue([{
    id: 'projection-1',
    schemaVersion: 'childcare-review-public-v1',
    careVertical: 'child',
    sourceReviewId: 'crev_review1',
    sourceVersion: 1,
    sourceStateVersion: 2,
    caregiverId: 'caregiver-1',
    clientName: '',
    rating: 5,
    comment: 'Attentive and reliable',
    date: '2026-07-25T00:00:00.000Z',
    moderationState: 'published',
    isPublic: true,
  }]);
});

describe('AdminReviews childcare moderation integration', () => {
  it('unpublishes a child projection through the CAS callable instead of direct delete', async () => {
    render(<AdminReviews />);
    expect(await screen.findByText('Attentive and reliable')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Unpublish review'));
    expect(await screen.findByText('Unpublish this review?')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    });

    expect(hoisted.moderate).toHaveBeenCalledWith({
      reviewId: 'crev_review1',
      expectedVersion: 2,
      decision: 'unpublished',
      reasonCode: 'unpublish_policy',
    });
    expect(hoisted.deleteReview).not.toHaveBeenCalled();
    expect(await screen.findByText('Review unpublished')).toBeTruthy();
  });
});
