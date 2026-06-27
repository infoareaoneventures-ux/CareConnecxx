// Pure helpers for the shift-swap visibility feature (U7).
//
// The UI reads the SANITIZED `shift_swap_summaries` collection (projected by the
// projectSwapSummary Cloud Function from both swap sources — caregiver-initiated
// shift_swap_requests and client-initiated shift_offers kind:'swap'). The raw
// collections are server-only; summaries carry no phone/name/candidate PII.
// Kept dependency-free so it can be unit-tested without Firebase.

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

/** Minimal shape of a Firestore doc snapshot the mapper consumes. */
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

/** Map a sanitized shift_swap_summaries doc to the UI's PendingSwap shape. */
export function mapSummaryDoc(doc: SwapDocLike): PendingSwap {
    const d = doc.data();
    return {
        id: doc.id,
        source: d.source === 'offer' ? 'offer' : 'swap_request',
        status: d.status,
        appointmentId: d.appointmentId ?? undefined,
        expiresAt: d.expiresAt ?? undefined,
        date: d.date ?? undefined,
        time: d.time ?? undefined,
    };
}
