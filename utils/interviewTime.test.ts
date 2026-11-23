import { describe, it, expect } from 'vitest';
import { interviewIsOver } from './interviewTime';

describe('interviewIsOver', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  it('is not over before or just after the start', () => {
    expect(interviewIsOver('2026-11-23T15:00:00Z', now)).toBe(false);
    expect(interviewIsOver('2026-11-23T11:30:00Z', now)).toBe(false);
  });
  it('is over an hour after the start', () => {
    expect(interviewIsOver('2026-11-23T10:30:00Z', now)).toBe(true);
    expect(interviewIsOver('2026-11-18T10:00:00Z', now)).toBe(true);
  });
  it('treats missing or unreadable times as not over', () => {
    expect(interviewIsOver(undefined, now)).toBe(false);
    expect(interviewIsOver('later', now)).toBe(false);
  });
});
