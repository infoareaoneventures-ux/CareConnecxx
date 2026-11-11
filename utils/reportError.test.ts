import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: sentry }));

import { reportError, swallow, isBenignError, registerErrorToast, __resetReportedErrors, userMessage } from './reportError';

beforeEach(() => { sentry.captureException.mockClear(); __resetReportedErrors(); registerErrorToast(null); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('reportError', () => {
  it('sends the failure to Sentry tagged with where it happened', () => {
    reportError(new Error('boom'), { where: 'Payments: load history' });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0][1]).toEqual({ tags: { where: 'Payments: load history' } });
  });

  it('wraps a non-Error in an Error', () => {
    reportError('plain string', { where: 'x' });
    expect(sentry.captureException.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('the same failure from the same place is reported once a minute, a different place at once', () => {
    reportError(new Error('boom'), { where: 'A' }, 1_000);
    reportError(new Error('boom'), { where: 'A' }, 30_000);
    reportError(new Error('boom'), { where: 'B' }, 30_000);
    reportError(new Error('boom'), { where: 'A' }, 62_000);
    expect(sentry.captureException).toHaveBeenCalledTimes(3);
  });

  it('expected failures (cancelled requests) are not reported', () => {
    expect(isBenignError(Object.assign(new Error('The user aborted a request'), { name: 'AbortError' }))).toBe(true);
    reportError(new Error('request cancelled'), { where: 'A' });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('tells the person only when asked, in the given sentence, never the raw error', () => {
    const toast = vi.fn(); registerErrorToast(toast);
    reportError(new Error('FirebaseError: Missing or insufficient permissions'), { where: 'A' });
    expect(toast).not.toHaveBeenCalled();
    reportError(new Error('FirebaseError: Missing or insufficient permissions'), { where: 'B', toast: "We couldn't load your payments. Please try again." });
    expect(toast).toHaveBeenCalledWith("We couldn't load your payments. Please try again.", 'error');
  });

  it('a failing reporter never throws into the caller', () => {
    sentry.captureException.mockImplementationOnce(() => { throw new Error('sentry down'); });
    expect(() => reportError(new Error('x'), { where: 'A' })).not.toThrow();
  });
});

describe('swallow / userMessage', () => {
  it('swallow reports and returns nothing', () => {
    expect(swallow('Home: jobs')(new Error('x'))).toBeUndefined();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
  it('userMessage keeps words written for people and hides infrastructure noise', () => {
    expect(userMessage(new Error('Valid email required'), 'fallback')).toBe('Valid email required');
    expect(userMessage(new Error('FirebaseError: permission-denied'), 'fallback')).toBe('fallback');
  });
});
