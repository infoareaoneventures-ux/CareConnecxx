// Pure helpers for the shift-swap visibility feature (U7).
//
// Two swap mechanisms exist: caregiver-initiated swaps live in
// `shift_swap_requests`; client-initiated swaps go through `shift_offers`
// (kind: 'swap'). These helpers normalize both into a single `PendingSwap`
// view and filter out terminal/expired entries. Kept dependency-free so they
// can be unit-tested without Firebase.

export interface PendingSwap {
    id: string;
    source: 'swap_request' | 'offer';
    status: string;            // swap_request: 'open' | 'accepted'; offer: 'pending' | ...
    appointmentId?: string;
    expiresAt?: string;
    date?: string;
    time?: string;
}

export const SWAP_ACTIVE_STATUSES = new Set(['open', 'accepted', 'pending']);

/** Minimal shape of a Firestore doc snapshot the mappers consume. */
export interface SwapDocLike {
    id: string;
    data: () => Record<string, any>;
}

/** Keep only active, non-expired swaps (drops declined/expired/terminal states). */
export function isActiveSwap(s: PendingSwap, now: number = Date.now()): boolean {
    if (!SWAP_ACTIVE_STATUSES.has(s.status)) return false;
    if (s.expiresAt && new Date(s.expiresAt).getTime() < now) return false;
    return true;
}

export function mapSwapRequestDoc(doc: SwapDocLike): PendingSwap {
    const d = doc.data();
    return {
        id: doc.id,
        source: 'swap_request',
        status: d.status,
        appointmentId: d.appointmentId,
        expiresAt: d.expiresAt,
        date: d.date,
        time: d.time,
    };
}

export function mapSwapOfferDoc(doc: SwapDocLike): PendingSwap {
    const d = doc.data();
    return {
        id: doc.id,
        source: 'offer',
        status: d.status,
        appointmentId: Array.isArray(d.appointmentIds) ? d.appointmentIds[0] : d.appointmentId,
        expiresAt: d.expiresAt,
        date: d.date,
        time: d.time,
    };
}
