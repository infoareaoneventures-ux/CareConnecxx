import { reportAuthError, withAuthCode } from './authErrorDetail';

/**
 * One plain-language line for a phone sign-in / sign-up failure. Known Firebase codes get a
 * sentence that says what to do next; only an unknown failure keeps the code at the end, so
 * support can ask for it. The error is reported (console + Sentry) in every case.
 */
export function friendlyAuthMessage(err: unknown, where: string, fallback = "We couldn't sign you in. Try again, or call us if it keeps happening."): string {
  const code = reportAuthError(where, err);
  switch (code) {
    case 'auth/too-many-requests':         return 'Too many attempts — wait a few minutes and try again.';
    case 'auth/invalid-phone-number':      return "That phone number doesn't look right. Check it and try again.";
    case 'auth/network-request-failed':    return 'Network hiccup — check your connection and try again.';
    case 'auth/code-expired':
    case 'auth/session-expired':           return 'That code expired. Tap "Resend code" to get a new one.';
    case 'auth/invalid-verification-code': return 'Incorrect code. Please try again.';
    case 'auth/quota-exceeded':            return "We can't send more codes right now. Please try again in a little while, or call us.";
    case 'auth/captcha-check-failed':
    case 'auth/missing-recaptcha-token':
    case 'auth/invalid-app-credential':
    case 'auth/web-storage-unsupported':   return "We couldn't confirm this isn't an automated request. Reload the page and try again, or call us.";
    case 'auth/user-disabled':             return 'This account is turned off. Please call us and we will sort it out.';
    case 'auth/operation-not-allowed':
    case 'auth/app-not-authorized':        return "Signing in isn't available on this device right now. Please call us.";
    case 'auth/missing-phone-number':      return 'Enter your mobile number to get a code.';
    default: return withAuthCode(fallback, code);
  }
}
