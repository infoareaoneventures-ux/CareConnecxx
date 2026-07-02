import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// U7 (docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md):
// post-OTP role-aware redirect (never the default-'client' fallback for a
// missing users doc), fresh reCAPTCHA per send, resend stays on the OTP step,
// friendly error copy.

const hoisted = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirm: vi.fn(async (_code: string): Promise<any> => ({ user: { uid: 'u1' } })),
  signInWithPhoneNumber: vi.fn(async (..._args: any[]): Promise<any> => ({ confirm: hoisted.confirm })),
  getUser: vi.fn(async (_uid: string): Promise<any> => ({ userType: 'client' })),
  getOrCreateRecaptchaVerifier: vi.fn(() => ({ verify: vi.fn() })),
  clearRecaptchaVerifier: vi.fn(),
}));

vi.mock('../../lib/firebase', () => ({
  auth: {
    signInWithPhoneNumber: hoisted.signInWithPhoneNumber,
    currentUser: { uid: 'u1' },
  },
  getOrCreateRecaptchaVerifier: hoisted.getOrCreateRecaptchaVerifier,
  clearRecaptchaVerifier: hoisted.clearRecaptchaVerifier,
}));

vi.mock('../../services/api', () => ({
  dbService: { getUser: hoisted.getUser },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => hoisted.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { AuthLoginPage } from './LoginPage';

const enterPhoneAndSend = async () => {
  fireEvent.change(screen.getByPlaceholderText('(555) 555-5555'), { target: { value: '4085551234' } });
  await act(async () => {
    fireEvent.click(screen.getByText(/Send code/));
  });
};

const enterOtp = async (code = '123456') => {
  const boxes = screen.getAllByRole('textbox');
  await act(async () => {
    code.split('').forEach((d, i) => fireEvent.change(boxes[i], { target: { value: d } }));
  });
};

describe('AuthLoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.signInWithPhoneNumber.mockResolvedValue({ confirm: hoisted.confirm });
    hoisted.confirm.mockResolvedValue({ user: { uid: 'u1' } });
    hoisted.getUser.mockResolvedValue({ userType: 'client' });
  });

  it('routes a client to /client/dashboard after OTP', async () => {
    render(<AuthLoginPage />);
    await enterPhoneAndSend();
    await enterOtp();
    await waitFor(() => expect(hoisted.navigate).toHaveBeenCalledWith('/client/dashboard', { replace: true }));
  });

  it('routes a caregiver to /caregiver/dashboard', async () => {
    hoisted.getUser.mockResolvedValue({ userType: 'caregiver' });
    render(<AuthLoginPage />);
    await enterPhoneAndSend();
    await enterOtp();
    await waitFor(() => expect(hoisted.navigate).toHaveBeenCalledWith('/caregiver/dashboard', { replace: true }));
  });

  it('routes an admin to /admin', async () => {
    hoisted.getUser.mockResolvedValue({ userType: 'admin' });
    render(<AuthLoginPage />);
    await enterPhoneAndSend();
    await enterOtp();
    await waitFor(() => expect(hoisted.navigate).toHaveBeenCalledWith('/admin', { replace: true }));
  });

  it('routes a user with NO users doc to /start, never a dashboard', async () => {
    hoisted.getUser.mockResolvedValue(null);
    render(<AuthLoginPage />);
    await enterPhoneAndSend();
    await enterOtp();
    await waitFor(() => expect(hoisted.navigate).toHaveBeenCalledWith('/start', { replace: true }));
  });

  it('recovers from a failed send: fresh verifier, retry succeeds', async () => {
    hoisted.signInWithPhoneNumber.mockRejectedValueOnce({ code: 'auth/network-request-failed' });
    render(<AuthLoginPage />);
    await enterPhoneAndSend();

    expect(screen.getByText(/Network hiccup/)).toBeTruthy();
    expect(hoisted.clearRecaptchaVerifier).toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByText(/Send code/)); });
    expect(screen.getByText('Enter your code')).toBeTruthy();
    expect(hoisted.getOrCreateRecaptchaVerifier).toHaveBeenCalledTimes(2);
  });

  it('resend stays on the OTP step', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<AuthLoginPage />);
      await enterPhoneAndSend();
      expect(screen.getByText('Enter your code')).toBeTruthy();

      // Each 1s tick schedules the next inside a state update, so advance
      // iteratively to let React re-render between ticks.
      for (let i = 0; i < 61 && !screen.queryByText('Resend code'); i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      }
      await act(async () => { fireEvent.click(screen.getByText('Resend code')); });

      expect(screen.getByText('Enter your code')).toBeTruthy(); // still OTP step
      expect(hoisted.signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps auth/too-many-requests to friendly copy, not the raw code', async () => {
    hoisted.signInWithPhoneNumber.mockRejectedValueOnce({ code: 'auth/too-many-requests', message: 'Firebase: auth/too-many-requests' });
    render(<AuthLoginPage />);
    await enterPhoneAndSend();

    expect(screen.getByText(/Too many attempts/)).toBeTruthy();
    expect(screen.queryByText(/auth\/too-many-requests/)).toBeNull();
  });

  it('expired code shows resend guidance', async () => {
    hoisted.confirm.mockRejectedValueOnce({ code: 'auth/code-expired' });
    render(<AuthLoginPage />);
    await enterPhoneAndSend();
    await enterOtp();

    await waitFor(() => expect(screen.getByText(/That code expired/)).toBeTruthy());
    expect(hoisted.navigate).not.toHaveBeenCalled();
  });
});
