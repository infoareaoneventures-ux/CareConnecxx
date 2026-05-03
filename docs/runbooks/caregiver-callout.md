# Caregiver Callout System - Operations Runbook

## Overview

This runbook covers operations for the caregiver callout and backup matching system. Use this guide when:
- A caregiver calls out and the system doesn't respond
- A family reports not receiving notifications
- Manual intervention is needed for caregiver matching
- Processing refund requests

## Quick Response Flow

```
Family Reports Issue
        │
        ▼
┌───────────────────┐
│ Check Appointment │──Error?──▶│ Check Logs │
│   Status in DB    │           │  (see #6)  │
└───────────────────┘           └────────────┘
        │
    Status OK
        │
        ▼
┌───────────────────┐
│ Check Client      │──No?─────▶│ Resend     │
│ Notifications     │           │ Notifications
└───────────────────┘           │ (see #3)   │
        │                       └────────────┘
   Notification OK
        │
        ▼
┌───────────────────┐
│ Family Needs      │
│ Manual Help?      │
└───────────────────┘
        │
   ┌────┴────┐
   ▼         ▼
Select    Refund
Backup    (see #5)
(see #4)
```

---

## 1. Check Appointment Status

**Command:**
```javascript
// Firebase Console > Firestore > appointments/{appointmentId}
```

**Expected Status Flow:**
1. `confirmed` → caregiver calls out
2. `caregiver_cancelled` → caregiver clicks button
3. `caregiver_called_out` → system processes
4. `confirmed` → family selects backup
5. `cancelled_refund_requested` → family requests refund

**If stuck at step 2:**
- Check `cancelledBy` field exists
- Check `caregiverCalloutReason` is populated
- Manually trigger: Update status to `caregiver_cancelled`

---

## 2. Find Backup Caregivers Manually

**When:** System doesn't find suitable backups

**Query:**
```javascript
// Firestore query
db.collection('caregivers')
  .where('verified', '==', true)
  .where('isActive', '==', true)
  .where('status', '==', 'approved')
  .get()
```

**Manual Selection Criteria:**
1. Check availability for appointment date/time
2. Verify not already booked (query appointments collection)
3. Match skills to service type
4. Sort by rating (highest first)
5. Top 3 = backup options

**Manual Update:**
```javascript
// Add to appointment document
{
  backupCaregiverOptions: [
    {
      caregiverId: "...",
      caregiverName: "...",
      rating: 4.8,
      hourlyRate: 28
    }
  ]
}
```

---

## 3. Resend Notifications

**When:** Family didn't receive callout notification

### Resend Push Notification
```javascript
const admin = require('firebase-admin');

const message = {
  token: 'DEVICE_FCM_TOKEN',
  notification: {
    title: '⚠️ Caregiver Cancelled',
    body: 'Your caregiver cancelled. 3 backups available.'
  },
  data: {
    appointmentId: 'APPOINTMENT_ID',
    type: 'caregiver_callout'
  }
};

admin.messaging().send(message);
```

### Resend SMS
```bash
# Use Twilio console or API
curl -X POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json \
  --data-urlencode "To=+1PHONE_NUMBER" \
  --data-urlencode "From=+1TWILIO_NUMBER" \
  --data-urlencode "Body=CareConnex: Your caregiver cancelled. View backup options: https://careconnex.app/a/APPOINTMENT_ID" \
  -u {AccountSid}:{AuthToken}
```

### Resend Email
```bash
# Use Resend dashboard or API
curl -X POST https://api.resend.com/emails \
  -H 'Authorization: Bearer {API_KEY}' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "CareConnex <noreply@careconnex.com>",
    "to": ["client@email.com"],
    "subject": "Caregiver Cancellation - Backup Options",
    "html": "<html>...</html>"
  }'
```

---

## 4. Manually Assign Backup Caregiver

**When:** Family asks admin to choose for them

**Steps:**
1. Get appointment ID and preferred caregiver ID from family
2. Run `selectBackupCaregiver` Cloud Function:

```javascript
const functions = require('firebase-functions');
const { getFunctions, httpsCallable } = require('firebase/functions');

const selectBackup = httpsCallable(functions, 'selectBackupCaregiver');
await selectBackup({
  appointmentId: 'APPOINTMENT_ID',
  backupCaregiverId: 'CAREGIVER_ID'
});
```

3. Verify appointment updated:
   - `caregiverId` = new caregiver
   - `status` = 'confirmed'
   - `previousCaregiverId` = old caregiver

4. Notify new caregiver via SMS:
   - "You've been assigned to care for [Client] on [Date] at [Time]"

5. Notify family:
   - "[Caregiver Name] has been assigned to your appointment"

---

## 5. Process Refund Request

**When:** Family requests refund (no suitable backups or changed mind)

**Steps:**

### 5.1 Verify Refund Request
```javascript
// Check refundRequests collection
db.collection('refundRequests')
  .where('appointmentId', '==', 'APPOINTMENT_ID')
  .get()
```

**Verify:**
- Status is 'pending'
- Amount is correct
- Reason is documented

### 5.2 Issue Refund via Stripe
```javascript
const stripe = require('stripe')('STRIPE_SECRET_KEY');

// Create refund
const refund = await stripe.refunds.create({
  payment_intent: 'PAYMENT_INTENT_ID',
  amount: AMOUNT_IN_CENTS, // or omit for full refund
  reason: 'requested_by_customer',
  metadata: {
    appointmentId: 'APPOINTMENT_ID',
    reason: 'Caregiver callout, no suitable backup'
  }
});
```

### 5.3 Update Records
```javascript
// Update refund request
db.collection('refundRequests').doc('REQUEST_ID').update({
  status: 'processed',
  processedAt: admin.firestore.FieldValue.serverTimestamp(),
  stripeRefundId: refund.id,
  processedBy: 'admin_email@careconnex.com'
});

// Update appointment
db.collection('appointments').doc('APPOINTMENT_ID').update({
  status: 'cancelled_refunded',
  refundedAt: admin.firestore.FieldValue.serverTimestamp(),
  refundAmount: refund.amount / 100
});
```

### 5.4 Notify Family
```javascript
// Create notification
db.collection('users').doc('CLIENT_ID').collection('notifications').add({
  title: 'Refund Processed',
  body: 'Your refund of $XX has been processed and will appear in 3-5 business days.',
  type: 'system',
  createdAt: admin.firestore.FieldValue.serverTimestamp()
});
```

---

## 6. Check Logs

**Firebase Functions Logs:**
```bash
firebase functions:log --only onCaregiverCallout
```

**Common Error Patterns:**

### Error: "No caregivers found"
**Cause:** All caregivers unavailable or none match criteria
**Fix:** Lower standards temporarily or offer refund

### Error: "Failed to send SMS"
**Cause:** Invalid phone number or Twilio issue
**Fix:** Check phone format, check Twilio dashboard

### Error: "FCM token not found"
**Cause:** Client hasn't enabled push notifications
**Fix:** Rely on SMS/email instead

### Error: "Permission denied"
**Cause:** Security rules blocking update
**Fix:** Check authentication, verify client owns appointment

---

## 7. Escalation Contacts

| Issue | Contact | Method |
|-------|---------|--------|
| Firebase outage | Firebase Support | console.firebase.google.com/support |
| Twilio issues | Twilio Support | twilio.com/help/contact |
| Resend issues | Resend Support | resend.com/support |
| Critical system failure | On-call engineer | PagerDuty |
| HIPAA concern | Compliance team | compliance@careconnex.com |

---

## 8. Monitoring Checklist

**Daily:**
- [ ] Check refundRequests queue (should be 0)
- [ ] Review yesterday's callouts
- [ ] Check error logs for notification failures

**Weekly:**
- [ ] Average time to find backups
- [ ] % of families who select backup vs refund
- [ ] Most common callout reasons

**Monthly:**
- [ ] Backup caregiver satisfaction
- [ ] Family satisfaction with callout process
- [ ] System reliability metrics

---

## Appendix A: Emergency Override

**If system is completely down:**

1. **Document current state** of all pending callouts
2. **Switch to manual process:**
   - Call caregiver to confirm cancellation
   - Call families to notify
   - Manually find backup caregivers
   - Call backup caregivers to confirm availability
   - Update appointment in Firebase Console
3. **Notify engineering** to fix system
4. **Post-mortem** after recovery

---

## Appendix B: Test Commands

```bash
# Test backup caregiver search
firebase functions:shell
getBackupCaregiverOptions({ appointmentId: "TEST_ID" })

# Test notification send
sendPushNotification("USER_ID", "Test", "Test message")

# Test refund flow
requestCalloutRefund({ appointmentId: "TEST_ID", reason: "Test" })
```
