# CareConnex Test Plan - Feb 2026

## 1. Caregiver Callout System Testing

### Test Case 1.1: Caregiver Initiates Callout
**Steps:**
1. Login as caregiver
2. Navigate to upcoming appointment
3. Click "Can't Make This Shift?"
4. Enter reason in modal
5. Submit callout

**Expected:**
- Appointment status changes to 'caregiver_cancelled'
- Client receives push notification
- Client receives SMS notification
- Client receives email notification
- 3 backup caregivers found and stored

**Status:** ⏳ Pending end-to-end test

### Test Case 1.2: Client Receives Notifications
**Steps:**
1. Trigger caregiver callout (from 1.1)
2. Check client notifications

**Expected:**
- In-app notification appears
- Push notification received
- SMS received within 60 seconds
- Email received with backup options

**Status:** ⏳ Pending

### Test Case 1.3: Client Selects Backup Caregiver
**Steps:**
1. Open callout modal
2. Review backup options
3. Select backup caregiver
4. Confirm selection

**Expected:**
- Appointment updated with new caregiver
- Original client notified
- New caregiver notified via SMS
- Status: 'confirmed'

**Status:** ⏳ Pending

### Test Case 1.4: Client Requests Refund
**Steps:**
1. Open callout modal
2. Click "Request Refund"
3. Confirm refund request

**Expected:**
- Appointment status: 'cancelled_refund_requested'
- Refund request created in admin queue
- Admin notification sent
- Client sees confirmation

**Status:** ⏳ Pending

---

## 2. Landing Page Testing

### Test Case 2.1: Mobile Responsiveness
**Devices:** iPhone, Android, iPad
**Checks:**
- Hero section readable
- CTA buttons tappable
- No horizontal scroll
- Images scale properly

**Status:** ⏳ Pending

### Test Case 2.2: Testimonials Display
**Checks:**
- Real caregiver quotes visible
- Family testimonials load
- Star ratings accurate
- Photos load (if applicable)

**Status:** 🔄 In Progress

### Test Case 2.3: FAQ Section
**Checks:**
- Questions expandable
- Santa Clara County pricing correct ($32-42 agency, $22-28 direct)
- Answers helpful and accurate

**Status:** ✅ Verified

---

## 3. Firebase Functions Testing

### Test Case 3.1: Push Notifications
**Trigger:** New message sent
**Expected:**
- FCM token retrieved
- Push notification delivered
- Background handler works

**Status:** ✅ Verified deployed

### Test Case 3.2: SMS Notifications
**Trigger:** Caregiver callout
**Expected:**
- Twilio integration active
- SMS delivered within 60s
- Invalid numbers handled

**Status:** ⏳ Pending verification

### Test Case 3.3: Email Notifications
**Trigger:** Caregiver callout
**Expected:**
- Resend API sends email
- HTML template renders correctly
- Plain text fallback works

**Status:** ✅ Code complete, pending test

---

## 4. Deployment Testing

### Test Case 4.1: Deploy Skill
**Command:** `.\skills\careconnex-deploy\deploy.ps1`
**Expected:**
- Pre-deploy checks pass
- Build succeeds
- Frontend deploys to Firebase Hosting
- Functions deploy successfully
- Verification confirms live URLs

**Status:** 🔄 Ready to test

---

## 5. Documentation

### Test Case 5.1: ADR - Caregiver Matching Algorithm
**Location:** `docs/adr/002-caregiver-matching.md`
**Contents:**
- Match scoring formula documented
- Availability check logic explained
- Distance considerations noted

**Status:** 🔄 In Progress

### Test Case 5.2: API Documentation
**Location:** `docs/api/caregiver-callout.md`
**Contents:**
- `onCaregiverCallout` trigger documented
- `selectBackupCaregiver` endpoint
- `requestCalloutRefund` endpoint
- `getBackupCaregiverOptions` endpoint

**Status:** 🔄 In Progress

### Test Case 5.3: Operations Runbook
**Location:** `docs/runbooks/caregiver-callout.md`
**Contents:**
- How to manually trigger callout
- How to process refund requests
- How to override caregiver matching
- Troubleshooting guide

**Status:** ⏳ Pending

---

## Summary

| Category | Complete | In Progress | Pending |
|----------|----------|-------------|---------|
| Callout Testing | 0 | 0 | 4 |
| Landing Page | 1 | 1 | 1 |
| Functions | 2 | 0 | 1 |
| Deployment | 0 | 1 | 0 |
| Documentation | 0 | 2 | 1 |

**Overall Progress:** 25% Complete
