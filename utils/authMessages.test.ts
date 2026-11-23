import { describe, it, expect, vi } from 'vitest';
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
import { friendlyAuthMessage } from './authMessages';

describe('friendlyAuthMessage', () => {
  it('turns the robot-check failure into a next step, with no code showing', () => {
    const m = friendlyAuthMessage({ code: 'auth/invalid-app-credential' }, 'test');
    expect(m).toMatch(/Reload the page/);
    expect(m).not.toMatch(/auth\//);
  });
  it('keeps the code only for an unknown failure, with the caller\'s fallback', () => {
    expect(friendlyAuthMessage({ code: 'auth/weird' }, 'test', 'We could not send the code.')).toBe('We could not send the code. (auth/weird)');
    expect(friendlyAuthMessage(new Error('x'), 'test', 'Oops.')).toBe('Oops.');
  });
  it('maps the common codes', () => {
    expect(friendlyAuthMessage({ code: 'auth/too-many-requests' }, 't')).toMatch(/Too many/);
    expect(friendlyAuthMessage({ code: 'auth/invalid-verification-code' }, 't')).toMatch(/Incorrect code/);
  });
});
