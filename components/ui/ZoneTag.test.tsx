import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ZoneTag } from './ZoneTag';

describe('ZoneTag', () => {
  it('names the zone for a visit outside Pacific', () => {
    const { container } = render(<ZoneTag visit={{ timeZone: 'America/Chicago' }} />);
    expect(container.textContent).toMatch(/\bC[SD]?T\b/);
  });
  it('reads the zone from the address ZIP when none is stamped', () => {
    const { container } = render(<ZoneTag visit={{ address: '1 Main St, Boston, MA 02108' }} />);
    expect(container.textContent).toMatch(/\bET\b/);
  });
  it('shows nothing for Pacific, for unknown or empty visits (existing screens are unchanged)', () => {
    expect(render(<ZoneTag visit={{ address: '4746 Campbell Ave, San Jose, CA 95130' }} />).container.textContent).toBe('');
    expect(render(<ZoneTag visit={{}} />).container.textContent).toBe('');
    expect(render(<ZoneTag visit={null} />).container.textContent).toBe('');
  });
});
