import { useRef, useState } from 'react';
import type firebase from 'firebase/compat/app';
import { auth, getOrCreateRecaptchaVerifier, clearRecaptchaVerifier } from '../lib/firebase';

function friendlyAuthError(err: any): string {
  switch (err?.code) {
    case 'auth/too-many-requests':         return 'Too many attempts — wait a few minutes and try again.';
    case 'auth/invalid-verification-code': return 'Incorrect code. Please try again.';
    case 'auth/code-expired':              return 'That code expired. Resend and try again.';
    case 'auth/network-request-failed':    return 'Network hiccup — check your connection and try again.';
    case 'auth/requires-recent-login':     return 'Please log out and back in, then try again.';
    default: return 'Something went wrong. Please try again.';
  }
}

// Re-proves control of the signed-in user's own phone number for a
// security-sensitive action (deleting the account). Login here is phone-OTP
// only — no account has a password credential — so this is the reauth path
// for every account, not a fallback for some of them.
export function usePhoneReauth(containerId: string) {
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const confirmationRef = useRef<firebase.auth.ConfirmationResult | null>(null);

  const sendCode = async (): Promise<boolean> => {
    setError('');
    const user = auth?.currentUser;
    if (!user?.phoneNumber) { setError('No phone number on this account.'); return false; }
    setSending(true);
    try {
      const verifier = getOrCreateRecaptchaVerifier(containerId, { size: 'invisible' });
      confirmationRef.current = await user.reauthenticateWithPhoneNumber(user.phoneNumber, verifier);
      return true;
    } catch (err: any) {
      setError(friendlyAuthError(err));
      return false;
    } finally {
      clearRecaptchaVerifier(containerId);
      setSending(false);
    }
  };

  const confirmCode = async (code: string): Promise<boolean> => {
    if (!confirmationRef.current) { setError('Request a code first.'); return false; }
    setError('');
    setConfirming(true);
    try {
      await confirmationRef.current.confirm(code);
      return true;
    } catch (err: any) {
      setError(friendlyAuthError(err));
      return false;
    } finally {
      setConfirming(false);
    }
  };

  const reset = () => {
    confirmationRef.current = null;
    setError('');
  };

  return { sendCode, confirmCode, reset, sending, confirming, error, setError };
}
