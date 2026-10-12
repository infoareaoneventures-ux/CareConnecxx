import { describe, it, expect, vi, beforeEach } from 'vitest';

// Settings / Membership "Renews on" line (founder, 2026-10-11): while Stripe is
// retrying a payment (past_due / payment_failed) the record being retried IS the
// live record — getSubscriptionStatus and listenToSubscriptionStatus read it
// through the ONE rule in utils/liveSubscription.ts (same as
// v1-getSubscriptionDetails and Evia's Membership section / page).

const hoisted = vi.hoisted(() => ({
    subs: [] as Array<Record<string, any>>,
    queries: [] as Array<{ where?: [string, string, string[]]; limit?: number }>,
}));

vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(async () => null) }));
vi.mock('firebase/functions', () => ({ getFunctions: vi.fn(), httpsCallable: vi.fn() }));
vi.mock('../lib/firebase', () => {
    const snapshotOf = (rows: Array<Record<string, any>>) => ({ empty: rows.length === 0, docs: rows.map((d) => ({ data: () => d })) });
    const q = (statuses: string[] | null, limit = Infinity): any => {
        const rows = () => (statuses ? hoisted.subs.filter((s) => statuses.includes(s.status)) : hoisted.subs).slice(0, limit);
        return {
            where: (f: string, op: string, v: string[]) => { hoisted.queries.push({ where: [f, op, v] }); return q(v, limit); },
            limit: (n: number) => { hoisted.queries.push({ limit: n }); return q(statuses, n); },
            get: async () => snapshotOf(rows()),
            onSnapshot: (cb: (s: any) => void) => { cb(snapshotOf(rows())); return () => {}; },
        };
    };
    const db = { collection: (name: string) => ({ doc: (uid: string) => ({ collection: (sub: string) => { expect(name).toBe('customers'); expect(uid).toBe('u1'); expect(sub).toBe('subscriptions'); return q(null); } }) }) };
    return { auth: { currentUser: { uid: 'u1' } }, db, functions: {}, storage: {}, app: {}, isConfigured: true, default: {} };
});

import { getSubscriptionStatus, listenToSubscriptionStatus } from './stripeService';

const END = { seconds: Math.floor(Date.parse('2026-10-17T07:00:00.000Z') / 1000) };

beforeEach(() => { hoisted.subs.length = 0; hoisted.queries.length = 0; });

describe('getSubscriptionStatus', () => {
    it('queries the four live statuses; a retrying (past_due) record beside an old canceled one is the record shown', async () => {
        hoisted.subs.push({ status: 'canceled', current_period_end: { seconds: 1 }, created: new Date('2025-01-01') });
        hoisted.subs.push({ status: 'past_due', current_period_end: END, cancel_at_period_end: false, price_id: 'price_x', created: new Date('2026-01-01') });
        const s = await getSubscriptionStatus();
        expect(s).toEqual({ status: 'past_due', currentPeriodEnd: new Date(END.seconds * 1000), cancelAtPeriodEnd: false, priceId: 'price_x' });
        expect(hoisted.queries[0]).toEqual({ where: ['status', 'in', ['active', 'trialing', 'past_due', 'payment_failed']] });
    });

    it('several live records → the most recently created; none live → whatever exists; nothing → null status', async () => {
        hoisted.subs.push({ status: 'past_due', price_id: 'older', created: new Date('2026-01-01') });
        hoisted.subs.push({ status: 'active', price_id: 'newer', created: new Date('2026-06-01') });
        expect((await getSubscriptionStatus()).priceId).toBe('newer');
        hoisted.subs.length = 0;
        hoisted.subs.push({ status: 'canceled', price_id: 'old_only' });
        expect(await getSubscriptionStatus()).toMatchObject({ status: 'canceled', priceId: 'old_only' });
        hoisted.subs.length = 0;
        expect(await getSubscriptionStatus()).toEqual({ status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, priceId: null });
    });
});

describe('listenToSubscriptionStatus', () => {
    it('same rule live: the retrying record is delivered; no live record → null status (no fallback to a canceled one)', () => {
        hoisted.subs.push({ status: 'canceled', price_id: 'old' });
        hoisted.subs.push({ status: 'payment_failed', current_period_end: END, price_id: 'failed', created: new Date('2026-01-01') });
        const seen: any[] = [];
        listenToSubscriptionStatus('u1', (s) => seen.push(s));
        expect(seen[0]).toMatchObject({ status: 'payment_failed', priceId: 'failed', currentPeriodEnd: new Date(END.seconds * 1000) });
        expect(hoisted.queries[0]).toEqual({ where: ['status', 'in', ['active', 'trialing', 'past_due', 'payment_failed']] });
        hoisted.subs.length = 0;
        hoisted.subs.push({ status: 'canceled', price_id: 'old' });
        listenToSubscriptionStatus('u1', (s) => seen.push(s));
        expect(seen[1]).toEqual({ status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, priceId: null });
    });
});
