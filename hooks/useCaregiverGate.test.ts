import { describe, it, expect, vi } from 'vitest';

vi.mock('../context/CareConnexContext', () => ({ useCareConnex: () => ({}) }));
vi.mock('../services/api', () => ({ dbService: {} }));
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));

import { caregiverBlockReasonFor } from './useCaregiverGate';

// The Jobs page gate as a pure function — the same rule firestore.rules runs on
// the application write and Evia's caregiverAccessGate.ts runs before its own.
const active = { membershipStatus: 'active', backgroundCheckStatus: 'clear' };
const badge = {
  ...active,
  services: ['Transportation'],
  documents: { driversLicense: { status: 'approved' }, insurance: { status: 'approved' }, registration: { status: 'approved' } },
  isApprovedDriver: true,
};

describe('caregiverBlockReasonFor', () => {
  it('membership first, then background', () => {
    expect(caregiverBlockReasonFor({}, false)).toBe('membership');
    expect(caregiverBlockReasonFor({ membershipPaid: true }, false)).toBe('background');
    expect(caregiverBlockReasonFor(active, false)).toBeNull();
  });
  it('a driving job needs the badge; a revoked driving record takes it away even with approved documents', () => {
    expect(caregiverBlockReasonFor(badge, true)).toBeNull();
    expect(caregiverBlockReasonFor({ ...badge, isApprovedDriver: false }, true)).toBe('transport');
    expect(caregiverBlockReasonFor(active, true)).toBe('transport');
    expect(caregiverBlockReasonFor(badge, false)).toBeNull();
  });
});
