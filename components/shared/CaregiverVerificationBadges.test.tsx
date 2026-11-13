import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { CaregiverVerificationBadges } from './CaregiverVerificationBadges';

describe('CaregiverVerificationBadges', () => {
  it('says "Background checked" in words, not "BGC+"', () => {
    const { container } = render(<CaregiverVerificationBadges verified backgroundCheckStatus="clear" />);
    expect(container.textContent).toBe('Background checked');
    expect(container.textContent).not.toMatch(/BGC/);
  });
  it('shows nothing until the check is clear', () => {
    expect(render(<CaregiverVerificationBadges verified backgroundCheckStatus="pending" />).container.textContent).toBe('');
  });
});
