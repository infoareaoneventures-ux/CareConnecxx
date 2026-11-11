import { describe, it, expect } from 'vitest';
import { reviewSummary } from './reviewSummary';
import { plainNotificationBody } from './notificationText';

describe('reviewSummary — the header agrees with the listed reviews', () => {
  it('one listed 5-star review is "1 review", not "No reviews yet", even if the profile summary has not caught up', () => {
    expect(reviewSummary({ rating: 0, reviewCount: 0 }, [{ rating: 5 }])).toEqual({ count: 1, rating: 5 });
  });
  it('averages what is listed; no listed reviews falls back to the profile summary', () => {
    expect(reviewSummary({}, [{ rating: 5 }, { rating: 4 }])).toEqual({ count: 2, rating: 4.5 });
    expect(reviewSummary({ rating: 4.6, reviewCount: 12 }, [])).toEqual({ count: 12, rating: 4.6 });
  });
  it('a profile count above the 20 listed keeps the profile figures', () => {
    expect(reviewSummary({ rating: 4.8, reviewCount: 35 }, Array.from({ length: 20 }, () => ({ rating: 5 })))).toEqual({ count: 35, rating: 4.8 });
  });
});

describe('plainNotificationBody — no raw web addresses', () => {
  it('drops the link and keeps a clean sentence', () => {
    expect(plainNotificationBody('Your interview with Basra is confirmed for Tuesday at 10:00 AM. Join from your Interviews tab: https://meet.google.com/abc-defg-hij'))
      .toBe('Your interview with Basra is confirmed for Tuesday at 10:00 AM. Join from your Interviews tab.');
    expect(plainNotificationBody('Open it at www.eviacares.com/client/posts now.')).toBe('Open it at now.');
  });
  it('leaves ordinary text alone and survives non-strings', () => {
    expect(plainNotificationBody('New job near you: Care in Gilroy · $25/hr.')).toBe('New job near you: Care in Gilroy · $25/hr.');
    expect(plainNotificationBody(undefined)).toBe('');
  });
});
