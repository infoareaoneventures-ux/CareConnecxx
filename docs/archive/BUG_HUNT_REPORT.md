# CareConnex Bug Hunt Report
## Comprehensive Code Review - Pre-Launch

**Report Date:** February 13, 2026  
**Reviewer:** Subagent Bug Hunt Team  
**Scope:** Complete codebase review across 8 critical areas  

---

## EXECUTIVE SUMMARY

**Total Bugs Found:** 34  
- **CRITICAL (P0):** 5 bugs - Must fix before launch
- **HIGH (P1):** 12 bugs - Should fix before launch
- **MEDIUM (P2):** 11 bugs - Fix in first patch
- **LOW (P3):** 6 bugs - Nice to have fixes

---

## CRITICAL BUGS (P0) - MUST FIX BEFORE LAUNCH

### 1. **CAREGIVER ID TYPE MISMATCH - DATABASE CORRUPTION RISK**
**Location:** `types.ts`, `services/api.ts`, `services/availabilityService.ts`
**Severity:** CRITICAL

**Issue:** Caregiver `id` is typed as `string` in `Caregiver` interface but `number` in `Appointment.caregiverId`. This causes type mismatches across the app.

```typescript
// types.ts - Caregiver interface
export interface Caregiver {
  id: string;  // <-- string
  // ...
}

// types.ts - Appointment interface
export interface Appointment {
  caregiverId: number;  // <-- number! MISMATCH
  // ...
}
```

**Impact:** Database queries may fail, type errors in production, potential data corruption when linking appointments to caregivers.

**Fix:** Standardize to `string` for all IDs (Firestore document IDs are strings).

---

### 2. **MISSING STRIPE WEBHOOK IDEMPOTENCY - DUPLICATE PAYMENT RISK**
**Location:** `functions/lib/stripe.js` - `stripeWebhook` handler
**Severity:** CRITICAL

**Issue:** The webhook handler doesn't check for duplicate events. If Stripe retries a webhook, payment status could be updated multiple times.

```javascript
// Current code (no idempotency check)
case 'payment_intent.succeeded': {
    const paymentIntent = event.data.object;
    await updatePaymentStatus(paymentIntent.id, 'succeeded');  // No duplicate check!
    break;
}
```

**Impact:** Duplicate payment processing, incorrect payment status, potential double-charging or incorrect payout calculations.

**Fix:** Store processed event IDs and skip duplicates:
```javascript
// Check if event already processed
const eventRef = db.collection('processed_stripe_events').doc(event.id);
const eventDoc = await eventRef.get();
if (eventDoc.exists) {
    res.json({ received: true, status: 'already_processed' });
    return;
}
await eventRef.set({ processedAt: new Date().toISOString() });
```

---

### 3. **INSUFFICIENT SSN VALIDATION - SECURITY HOLE**
**Location:** `utils/validation.ts` - `ssn` validator
**Severity:** CRITICAL

**Issue:** SSN validation only checks format, doesn't validate against common fake SSNs or invalid ranges.

```typescript
ssn: (value: string): string | null => {
    const ssnRegex = /^\d{3}-?\d{2}-?\d{4}$/;
    if (!ssnRegex.test(value)) {
      return 'Invalid SSN format (use XXX-XX-XXXX)';
    }
    return null;  // No further validation!
},
```

**Impact:** Users can submit fake/invalid SSNs like "000-00-0000", "123-45-6789", or "666-00-0000" which are invalid.

**Fix:** Add additional validation:
```typescript
const INVALID_SSNS = [
  '000-00-0000', '111-11-1111', '222-22-2222', '333-33-3333',
  '444-44-4444', '555-55-5555', '666-66-6666', '777-77-7777',
  '888-88-8888', '999-99-9999', '123-45-6789'
];
const areaNumber = value.substring(0, 3);
if (areaNumber === '000' || areaNumber === '666') {
  return 'Invalid SSN: Invalid area number';
}
if (INVALID_SSNS.includes(value.replace(/-/g, ''))) {
  return 'Invalid SSN: This SSN is not valid';
}
```

---

### 4. **RACE CONDITION IN DOUBLE-BOOKING CHECK**
**Location:** `services/api.ts` - `createAppointment`
**Severity:** CRITICAL

**Issue:** The transaction checks for conflicts but doesn't properly lock the time slot. Two simultaneous requests could both pass the check and create conflicting appointments.

```typescript
// Current code - vulnerable to race condition
return await db.runTransaction(async (transaction) => {
    const existingApptsQuery = db.collection('appointments')
        .where('caregiverId', '==', caregiverId)
        .where('date', '==', date)
        .where('time', '==', time);
    
    const existingApptsSnap = await transaction.get(existingApptsQuery);
    // Race condition: another transaction could insert here
    
    if (!existingApptsSnap.empty) {
        throw new Error('This time slot is no longer available');
    }
    // ... create appointment
});
```

**Impact:** Double-booking could occur under high load, causing caregiver scheduling conflicts.

**Fix:** Use Firestore document locking with a time slot document:
```typescript
// Create a lock document for each time slot
const lockRef = db.collection('appointment_locks').doc(`${caregiverId}_${date}_${time}`);
const lockDoc = await transaction.get(lockRef);
if (lockDoc.exists) {
    throw new Error('This time slot is no longer available');
}
transaction.set(lockRef, { locked: true, createdAt: new Date().toISOString() });
```

---

### 5. **BYPASSABLE FILE SIZE VALIDATION IN STORAGE RULES**
**Location:** `storage.rules`
**Severity:** CRITICAL

**Issue:** Storage rules have a typo causing size validation to fail:

```
request.resource.size < 5 * 1024 * 1025  // <-- TYPO: 1025 instead of 1024
```

**Impact:** Allows files slightly larger than intended. More critically, the validation is at the wrong scope.

**Fix:** 
```
request.resource.size < 5 * 1024 * 1024  // Fix: 1024 not 1025
```

---

## HIGH SEVERITY BUGS (P1) - SHOULD FIX BEFORE LAUNCH

### 6. **NO RATE LIMITING ON CLIENT-SIDE API CALLS**
**Location:** `services/api.ts` - Multiple endpoints
**Severity:** HIGH

**Issue:** While Firebase Functions have rate limiting, the client-side API service (`authService.signup`, `dbService.createAppointment`) doesn't implement any rate limiting. A malicious user could spam signups or bookings.

**Fix:** Add client-side rate limiting to critical endpoints:
```typescript
const rateLimiter = new Map<string, number>();
const checkClientRateLimit = (key: string, windowMs: number = 60000): boolean => {
    const lastCall = rateLimiter.get(key);
    if (lastCall && Date.now() - lastCall < windowMs) {
        throw new Error('Please wait before trying again');
    }
    rateLimiter.set(key, Date.now());
    return true;
};
```

---

### 7. **MISSING INPUT SANITIZATION IN REVIEW SUBMISSION**
**Location:** `components/ReviewModal.tsx`
**Severity:** HIGH

**Issue:** Review comments are not sanitized before submission:

```typescript
const handleSubmit = () => {
    if (rating > 0) {
        onSubmit(rating, comment);  // comment not sanitized!
        onClose();
    }
};
```

**Impact:** Potential XSS if comment is rendered without sanitization elsewhere.

**Fix:** Import and use sanitize:
```typescript
import { sanitizeMessage } from '../utils/sanitize';
const handleSubmit = () => {
    if (rating > 0) {
        onSubmit(rating, sanitizeMessage(comment));
        onClose();
    }
};
```

---

### 8. **INCORRECT ERROR HANDLING IN STRIPE ONBOARDING**
**Location:** `services/api.ts` - `stripeService.initiateOnboarding`
**Severity:** HIGH

**Issue:** Error handling catches and re-throws generic errors without proper context:

```typescript
catch (error: unknown) {
    console.error("Stripe Onboarding Failed:", error);
    throw error instanceof Error ? error : new Error('Stripe onboarding failed');
}
```

This doesn't properly handle specific Stripe error types.

**Fix:** Implement proper error classification and user-friendly messages.

---

### 9. **UNHANDLED PROMISE REJECTION IN DOCUMENT UPLOAD**
**Location:** `components/CaregiverSignup.tsx`
**Severity:** HIGH

**Issue:** The document upload handler has an unhandled promise:

```typescript
const handleDocumentUpload = useCallback(async (file: File, type: DocumentType) => {
    try {
        // ...
    } catch (error) {
        console.error('Document selection error:', error);
        onShowToast(error instanceof Error ? error.message : 'Failed to select document', 'error');
    }
}, [onShowToast]);
```

The issue is that `_pendingFile` is stored but never actually uploaded to Firebase Storage.

**Impact:** Documents appear uploaded in UI but aren't persisted to storage.

**Fix:** Actually upload the file in `handleSubmit`:
```typescript
// In handleSubmit, upload pending documents
for (const [type, doc] of Object.entries(documents)) {
    if (doc?._pendingFile) {
        await documentUploadService.uploadDocument(user.uid, doc._pendingFile, type as DocumentType);
    }
}
```

---

### 10. **INSUFFICIENT PASSWORD VALIDATION**
**Location:** `utils/validation.ts` - `validateSignup`
**Severity:** HIGH

**Issue:** Password validation in `validateSignup` only checks length (6 chars), doesn't enforce complexity:

```typescript
if (!data.password || data.password.length < 6) {
    errors.push({ field: 'password', message: 'Password must be at least 6 characters' });
}
```

This is inconsistent with the `validators.password` function which requires uppercase, lowercase, and number.

**Impact:** Weak passwords allowed in signup, security vulnerability.

**Fix:** Use consistent password validation across all signup flows.

---

### 11. **MISSING APPOINTMENT DURATION FIELD**
**Location:** `types.ts` - `Appointment` interface
**Severity:** HIGH

**Issue:** The `Appointment` type has no `duration` field, but it's used throughout availability checking. The system assumes 3 hours by default which may be incorrect.

```typescript
export interface Appointment {
    // ...
    cost: number;  // Used to estimate duration: cost / hourlyRate
    // No explicit duration field!
}
```

**Impact:** Incorrect conflict detection, caregivers may be double-booked if appointment durations vary.

**Fix:** Add explicit `duration: number` field to Appointment interface and use it in conflict checking.

---

### 12. **CANCELLATION MODAL ALLOWS PAST DATE CANCELLATION**
**Location:** `components/CancellationModal.tsx`
**Severity:** HIGH

**Issue:** Users can attempt to cancel appointments that have already passed:

```typescript
const diffHours = (apptDate.getTime() - now.getTime()) / (1000 * 60 * 60);
const isLateCancel = diffHours < 24 && diffHours > 0;  // Only checks future dates
```

No check prevents cancelling past appointments.

**Fix:** Add validation:
```typescript
if (diffHours < 0) {
    onShowToast("Cannot cancel appointments that have already passed", 'error');
    return;
}
```

---

### 13. **TIMEZONE ISSUES IN APPOINTMENT BOOKING**
**Location:** `components/BookingModal.tsx`
**Severity:** HIGH

**Issue:** Date generation uses local timezone but stores ISO date:

```typescript
const dates = Array.from({ length: 30 }).map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i + 1);
    const localIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // ...
});
```

Different users in different timezones may see different dates for the same appointment.

**Impact:** Booking confusion, missed appointments due to timezone mismatches.

**Fix:** Store dates in UTC with timezone offset, display in user's local timezone.

---

### 14. **NO VALIDATION ON INSURANCE POLICY PURCHASE**
**Location:** `components/BookingModal.tsx` - `handleConfirmBooking`
**Severity:** HIGH

**Issue:** Insurance policy purchase failure is silently ignored:

```typescript
if (includeInsurance && insuranceQuote) {
    try {
        const policy = await bunkerService.purchasePolicy(...);
        // Add insurance details to appointment
    } catch (error) {
        console.error('Failed to purchase insurance:', error);
        // Continue with booking even if insurance fails  // <-- PROBLEM!
    }
}
```

**Impact:** User thinks they have insurance coverage when they don't.

**Fix:** Either require insurance purchase success or clearly notify user of failure.

---

### 15. **BIO MAX LENGTH VALIDATION ONLY CLIENT-SIDE**
**Location:** `components/CaregiverSignup.tsx`
**Severity:** HIGH

**Issue:** Bio length is only checked client-side:

```typescript
if (step === 2 && bio.length > 500) {
    onShowToast("Bio must be 500 characters or less", 'error');
    return;
}
```

No server-side validation exists.

**Impact:** Malicious users could bypass client-side validation and store very large bios.

**Fix:** Add server-side validation in Firestore rules or Cloud Function.

---

### 16. **CHAT SERVICE MISSING ERROR HANDLING IN SUBSCRIPTION**
**Location:** `services/chatService.ts`
**Severity:** HIGH

**Issue:** The `subscribeToMessages` function doesn't handle subscription errors:

```typescript
subscribeToMessages(chatRoomId: string, callback: (messages: Message[]) => void) {
    const q = query(/* ... */);
    return onSnapshot(q, (snapshot) => {
        // ...
    });  // No error handler!
}
```

**Impact:** Silent failures, users may not see chat messages without knowing there's an issue.

**Fix:** Add error handler:
```typescript
return onSnapshot(q, 
    (snapshot) => { /* ... */ },
    (error) => {
        console.error('Chat subscription error:', error);
        callback([]); // Return empty array on error
    }
);
```

---

### 17. **PHONE NUMBER FORMAT INCONSISTENT**
**Location:** Multiple files
**Severity:** HIGH

**Issue:** Phone numbers are stored inconsistently - some with formatting, some without:

```typescript
// CaregiverSignup.tsx - stores formatted
value={basicInfo.phone}
onChange={(e) => setBasicInfo({ ...basicInfo, phone: formatPhoneNumber(e.target.value) })}

// But validators.phone expects digits only:
phone: (value: string): string | null => {
    const digits = value.replace(/\D/g, '');
    if (digits.length !== 10) {
      return 'Phone number must be 10 digits';
    }
    return null;
}
```

**Impact:** Validation may fail unexpectedly, search/filter by phone number may not work.

**Fix:** Normalize phone numbers to E.164 format before storage.

---

## MEDIUM SEVERITY BUGS (P2) - FIX IN FIRST PATCH

### 18. **MISSING INDEX FOR CAREGIVER AVAILABILITY QUERY**
**Location:** `firestore.indexes.json`
**Severity:** MEDIUM

**Issue:** No composite index for querying caregivers by availability and verification status.

**Fix:** Add index:
```json
{
  "collectionGroup": "caregivers",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "verificationStatus", "order": "ASCENDING" },
    { "fieldPath": "weeklyAvailability", "order": "ASCENDING" }
  ]
}
```

---

### 19. **UNUSED VARIABLE IN AVAILABILITY SERVICE**
**Location:** `services/availabilityService.ts`
**Severity:** MEDIUM

**Issue:** `minutesToTime` function is defined but never used:

```typescript
function minutesToTime(minutes: number): string {
    // Never called!
}
```

**Fix:** Remove unused code or implement the missing feature.

---

### 20. **NOTIFICATION RATE LIMITER NOT SHARED ACROSS INSTANCES**
**Location:** `services/notificationService.ts`
**Severity:** MEDIUM

**Issue:** Rate limiters use `Map` which is per-instance, not shared:

```typescript
const smsRateLimiter = new Map<string, number>();  // New map per page load!
```

**Impact:** Rate limiting only works within a single session, users can bypass by refreshing.

**Fix:** Use a server-side rate limiter (Firebase Realtime Database or Firestore).

---

### 21. **CAREGIVER SIGNUP DOESN'T VERIFY EMAIL**
**Location:** `components/CaregiverSignup.tsx`
**Severity:** MEDIUM

**Issue:** No email verification is sent during caregiver signup.

**Impact:** Fake email addresses can be used to create accounts.

**Fix:** Send verification email after signup:
```typescript
await auth.currentUser?.sendEmailVerification();
```

---

### 22. **NO FALLBACK FOR MISSING CAREGIVER PHOTO**
**Location:** `components/BookingModal.tsx`
**Severity:** MEDIUM

**Issue:** If `caregiver.imageUrl` is undefined, the image will show a broken icon:

```typescript
<img
    src={caregiver.imageUrl}  // Could be undefined!
    alt={caregiver.name}
    className="w-16 h-16 rounded-xl object-cover"
/>
```

**Fix:** Add fallback:
```typescript
src={caregiver.imageUrl || '/default-avatar.png'}
```

---

### 23. **MEMORY LEAK IN CAREGIVER SIGNUP**
**Location:** `components/CaregiverSignup.tsx`
**Severity:** MEDIUM

**Issue:** Object URLs created for document previews are never revoked if component unmounts before submit:

```typescript
const tempUrl = URL.createObjectURL(file);
// Only revoked in handleDocumentDelete, not on unmount
```

**Fix:** Use `useEffect` cleanup:
```typescript
useEffect(() => {
    return () => {
        // Revoke all object URLs on unmount
        Object.values(documents).forEach(doc => {
            if (doc?.url?.startsWith('blob:')) {
                URL.revokeObjectURL(doc.url);
            }
        });
    };
}, []);
```

---

### 24. **INSUFFICIENT VALIDATION ON HOURLY RATE**
**Location:** `components/CaregiverSignup.tsx`
**Severity:** MEDIUM

**Issue:** No validation on hourly rate input:

```typescript
<Input
    label="Hourly Rate ($)" type="number" required
    value={logistics.rate}
    onChange={(e) => setLogistics({ ...logistics, rate: e.target.value })}
/>
```

Users could enter $0, negative values, or extremely high rates.

**Fix:** Add min/max validation:
```typescript
const rate = parseInt(e.target.value);
if (rate < 15 || rate > 200) {
    onShowToast("Hourly rate must be between $15 and $200", 'error');
    return;
}
```

---

### 25. **NO SESSION TIMEOUT HANDLING**
**Location:** `services/api.ts`
**Severity:** MEDIUM

**Issue:** No handling for expired Firebase auth tokens during long-running operations.

**Impact:** Users may get cryptic errors after session expires.

**Fix:** Add token refresh logic or session expiry warnings.

---

### 26. **RATING SERVICE MISSING TRANSACTION**
**Location:** `services/ratingService.ts` - `submitReview`
**Severity:** MEDIUM

**Issue:** The rating update uses a batch but doesn't check if the review already exists:

```typescript
async submitReview(reviewData: Omit<Review, 'id' | 'createdAt' | 'timestamp'>): Promise<string> {
    // No check for duplicate review!
    const batch = writeBatch(db);
    // ...
}
```

**Impact:** Duplicate reviews possible if user submits twice.

**Fix:** Check for existing review by appointment ID before creating new one.

---

### 27. **STORAGE RULES ALLOW ADMIN ACCESS WITHOUT VERIFICATION**
**Location:** `storage.rules`
**Severity:** MEDIUM

**Issue:** Admin access is determined by metadata, not authenticated role:

```
allow read: if isAuthenticated() && (
    request.auth.uid == userId ||  
    resource.metadata.adminAccess == 'true'  // <-- Can be set by anyone!
);
```

**Impact:** If a user can upload a file with `adminAccess: 'true'` metadata, they can read other users' files.

**Fix:** Use Firestore to verify admin role:
```
allow read: if isAuthenticated() && (
    request.auth.uid == userId || 
    isAdmin()  // Check admin role properly
);
```

---

### 28. **DEMO MODE EXPOSES SENSITIVE INFO IN LOGS**
**Location:** `config/demoMode.ts`
**Severity:** MEDIUM

**Issue:** Demo mode logs detailed info:

```typescript
if (import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true') {
    console.log(`🔧 Demo Mode: ${DEMO_MODE ? 'ENABLED' : 'DISABLED'}`);
}
```

**Impact:** If debug flags are accidentally enabled in production, sensitive data may be logged.

**Fix:** Remove debug logging from production builds entirely.

---

## LOW SEVERITY BUGS (P3) - NICE TO HAVE

### 29. **TYPO IN ERROR MESSAGE**
**Location:** `utils/validation.ts`
**Severity:** LOW

```typescript
return 'Phone number must be 10 digits';
```

Should be "10 digits" but US phone numbers are technically 10 digits (not counting country code). Message could be clearer.

---

### 30. **UNUSED IMPORTS**
**Location:** Multiple files
**Severity:** LOW

Several files have unused imports that increase bundle size:
- `CaregiverSignup.tsx` imports `FileText`, `Upload` but doesn't use them
- `BookingModal.tsx` imports `MapPin` but uses inline SVG

---

### 31. **INCONSISTENT BUTTON STYLING**
**Location:** `components/CancellationModal.tsx`
**Severity:** LOW

The confirm cancellation button uses custom classes instead of the Button component's variant system:

```typescript
className="bg-red-600 hover:bg-red-700 text-white border-none"
```

**Fix:** Use `variant="danger"` or add danger variant to Button component.

---

### 32. **NO ARIA LABELS ON ICON BUTTONS**
**Location:** Multiple components
**Severity:** LOW

Icon buttons lack accessibility labels:

```typescript
<button onClick={onClose} className="...">
    <X size={24} />
</button>
```

**Fix:** Add aria-label:
```typescript
<button onClick={onClose} className="..." aria-label="Close modal">
    <X size={24} />
```

---

### 33. **HARD-CODED MAGIC NUMBERS**
**Location:** Multiple files
**Severity:** LOW

Hard-coded values without constants:
- `3` (hours) appears in multiple places as default duration
- `$2.00` insurance fee is hard-coded
- `500` character limit for bio

**Fix:** Extract to named constants:
```typescript
const DEFAULT_APPOINTMENT_HOURS = 3;
const INSURANCE_FEE_CENTS = 200;
const MAX_BIO_LENGTH = 500;
```

---

### 34. **MISSING LOADING STATE FOR INSURANCE QUOTE**
**Location:** `components/BookingModal.tsx`
**Severity:** LOW

When fetching insurance quote, there's no visual feedback during the loading state beyond the quote value being null.

**Fix:** Add explicit loading spinner or skeleton loader.

---

## RECOMMENDED FIX PRIORITY ORDER

### Week 1 (Pre-Launch) - CRITICAL & HIGH
1. Fix caregiver ID type mismatch (#1)
2. Add Stripe webhook idempotency (#2)
3. Fix SSN validation (#3)
4. Fix race condition in booking (#4)
5. Fix storage rules typo (#5)
6. Add rate limiting to client-side (#6)
7. Add review sanitization (#7)
8. Fix document upload persistence (#9)
9. Fix password validation consistency (#10)
10. Add appointment duration field (#11)
11. Fix past appointment cancellation (#12)
12. Fix timezone issues (#13)

### Week 2 (Launch Week) - HIGH & MEDIUM
13. Handle insurance purchase failures (#14)
14. Add server-side bio validation (#15)
15. Fix chat subscription errors (#16)
16. Normalize phone number format (#17)
17. Add missing Firestore indexes (#18)
18. Fix notification rate limiting (#20)
19. Add email verification (#21)
20. Add caregiver photo fallback (#22)

### Week 3 (Post-Launch) - MEDIUM & LOW
21. Fix memory leaks (#23)
22. Add rate input validation (#24)
23. Add session timeout handling (#25)
24. Fix rating service duplicate check (#26)
25. Fix storage admin access (#27)
26. Remove debug logging (#28)
27. Fix accessibility issues (#32)
28. Extract magic numbers to constants (#33)

---

## SECURITY SUMMARY

| Category | Status | Notes |
|----------|--------|-------|
| XSS Prevention | ✅ GOOD | DOMPurify properly configured |
| SQL Injection | N/A | No SQL database |
| Auth | ⚠️ FAIR | Needs email verification, session timeout |
| Input Validation | ⚠️ FAIR | Some client-side only validation |
| Rate Limiting | ⚠️ FAIR | Server-side good, client-side missing |
| Data Sanitization | ⚠️ FAIR | Missing in review submission |
| File Upload | ⚠️ FAIR | Size validation typo needs fix |
| Firestore Rules | ⚠️ FAIR | Good structure, minor issues |

---

## PERFORMANCE NOTES

- Bundle size could be optimized by removing unused imports
- Chat pagination is implemented but not used in UI
- Firestore indexes are mostly configured but missing a few
- Image optimization not implemented (next-gen formats, lazy loading)

---

## END OF REPORT

**Next Steps:**
1. Triage bugs with PM (Jarvis)
2. Create tickets for P0 and P1 bugs
3. Assign to developers
4. Schedule follow-up review after fixes
