import { describe, it, expect } from 'vitest';
import { LIVE_SUBSCRIPTION_STATUSES, isLiveSubscriptionStatus, pickLiveSubscription } from './liveSubscription';

// The ONE "live subscription record" rule the site's getSubscriptionStatus /
// listenToSubscriptionStatus read (founder, 2026-10-11): active, trialing AND
// Stripe's retry states past_due / payment_failed; most recent wins. Verbatim
// twin of functions/src/utils/liveSubscription.ts (its test pins the two equal).

describe('liveSubscription (site twin)', () => {
    it('active, trialing, past_due and payment_failed are live; canceled / unpaid / incomplete are not', () => {
        expect([...LIVE_SUBSCRIPTION_STATUSES]).toEqual(['active', 'trialing', 'past_due', 'payment_failed']);
        expect(isLiveSubscriptionStatus('past_due')).toBe(true);
        expect(isLiveSubscriptionStatus('payment_failed')).toBe(true);
        expect(isLiveSubscriptionStatus('canceled')).toBe(false);
        expect(isLiveSubscriptionStatus(undefined)).toBe(false);
    });

    it('a retrying record beside an old canceled one IS the record; several live → the most recently created', () => {
        expect(pickLiveSubscription([{ status: 'canceled', id: 'old' }, { status: 'past_due', id: 'retry' }])?.id).toBe('retry');
        expect(pickLiveSubscription([
            { status: 'past_due', id: 'older', created: { seconds: 1_700_000_000 } },
            { status: 'active', id: 'newer', created: { seconds: 1_800_000_000 } },
        ])?.id).toBe('newer');
        expect(pickLiveSubscription([{ status: 'canceled' }])).toBeNull();
    });
});
