import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const resolveAdminAlert = vi.fn(async () => {});
vi.mock('../../services/api', () => ({
  dbService: {
    resolveAdminAlert: (...a: unknown[]) => (resolveAdminAlert as (...x: unknown[]) => Promise<void>)(...a),
    subscribeEmergencyAlerts: (cb: (rows: unknown[]) => void) => {
      cb([{ id: 'e1', type: 'emergency', kind: 'medical', name: 'Riya', role: 'caregiver', userId: 'cg', phone: '+14085550102', said: 'The client fell',
        notified: [{ name: 'Sam', relation: 'emergency contact', phone: '+14085550103', status: 'sent' }, { name: 'Usman', relation: 'family', status: 'skipped_opt_out' }] }]);
      return () => {};
    },
  },
}));

import { AdminEmergencies } from './AdminEmergencies';

describe('AdminEmergencies', () => {
  it('shows who, what was said, who was and was not reached, and the actions', () => {
    const onOpen = vi.fn();
    render(<AdminEmergencies onOpen={onOpen} onShowToast={() => {}} />);
    expect(screen.getByText('Medical emergency')).toBeTruthy();
    expect(screen.getByText('“The client fell”')).toBeTruthy();
    expect(screen.getByText(/Texted Sam/)).toBeTruthy();
    expect(screen.getByText(/NOT delivered to Usman/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Call \+14085550102/ }).getAttribute('href')).toBe('tel:+14085550102');
    fireEvent.click(screen.getByRole('button', { name: /Open conversation/ }));
    expect(onOpen).toHaveBeenCalledWith('cg', 'caregiver');
    fireEvent.click(screen.getByRole('button', { name: /Mark resolved/ }));
    expect(resolveAdminAlert).toHaveBeenCalledWith('e1');
  });
});
