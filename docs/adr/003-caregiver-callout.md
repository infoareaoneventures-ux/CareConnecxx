# ADR-003: Caregiver Callout & Backup Matching System

## Status
**Accepted** - Implemented and deployed February 2026

## Context

When caregivers cancel shifts (call out), families need immediate alternatives. Traditional agencies take hours or days to find replacements. We need an automated system that:

1. Instantly notifies families when a caregiver cancels
2. Finds qualified backup caregivers within minutes
3. Allows families to select replacements or request refunds
4. Maintains trust through transparency and speed

## Decision

Implement a fully automated caregiver callout system with multi-channel notifications and AI-driven backup matching.

### Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Caregiver App  │────▶│  Cloud Function  │────▶│   Firestore DB  │
│  (Calls Out)    │     │  onCaregiverCall │     │ (Update Status) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  Backup Matcher  │
                       │  (Find 3 best)   │
                       └──────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
         ┌──────────┐    ┌──────────┐    ┌──────────┐
         │   Push   │    │   SMS    │    │  Email   │
         │   (FCM)  │    │ (Twilio) │    │ (Resend) │
         └──────────┘    └──────────┘    └──────────┘
```

### Matching Algorithm

**Score Calculation:**
```javascript
score = (rating * 1) +           // 0-5 points
        (hasSkills ? 5 : 0) +    // 5 points if skills match
        (rate < 30 ? 3 : 0)      // 3 points if competitive rate
```

**Filters Applied:**
1. Verified and active caregivers only
2. Not the original caregiver
3. Available at appointment date/time
4. Not already booked at that time
5. Skills match service type
6. Within reasonable distance (future: geospatial)

### Notification Channels

**Priority Order:**
1. **In-app notification** - Instant, persistent
2. **Push notification** - FCM to all user devices
3. **SMS** - Twilio within 60 seconds
4. **Email** - HTML + text fallback

**Content Strategy:**
- Push: Concise, actionable ("3 backup caregivers available")
- SMS: Brief with link (character limit)
- Email: Full details with caregiver profiles, ratings, photos

### Data Model

**Appointment Document:**
```typescript
{
  status: 'caregiver_called_out',
  cancelledBy: 'caregiver',
  caregiverCalloutReason: string,
  needsBackup: boolean,
  backupCaregiverOptions: [...],
  previousCaregiverId: string,
  caregiverSwitchedAt: timestamp
}
```

**Notification Document:**
```typescript
{
  type: 'callout',
  title: 'Caregiver Cancelled',
  body: string,
  isRead: boolean,
  data: {
    appointmentId: string,
    backupCaregivers: [...],
    action: 'select_backup_caregiver'
  }
}
```

## Consequences

### Positive

1. **Speed**: Families get options within 2-3 minutes vs hours
2. **Transparency**: See backup caregiver profiles immediately
3. **Control**: Family chooses replacement, not assigned blindly
4. **Trust**: Multi-channel notifications ensure they know ASAP
5. **Fairness**: Caregivers who are available get opportunity

### Negative

1. **Complexity**: More moving parts than manual replacement
2. **Cost**: SMS and email services add operational cost
3. **Edge Cases**: What if no backups available? (handled via refund flow)

### Mitigations

- **Rate limiting** on notifications to prevent spam
- **Fallback flow** when no backups (refund option)
- **Admin dashboard** for manual override when needed
- **Logging** for HIPAA audit trail

## Alternatives Considered

### Option 1: Manual Replacement (Status Quo)
- **Rejected**: Too slow, families lose trust

### Option 2: Auto-Assign Backup
- **Rejected**: Removes family choice, potential mismatches

### Option 3: Notification Only (No Matching)
- **Rejected**: Family still has to search manually

## Implementation Notes

### Cloud Functions
- `onCaregiverCallout` - Triggered on appointment status change
- `getBackupCaregiverOptions` - Client fetches options
- `selectBackupCaregiver` - Client selects replacement
- `requestCalloutRefund` - Client requests refund

### Frontend Components
- `CaregiverCalloutButton` - Caregiver initiates callout
- `CaregiverCalloutModal` - Client views/selects backups
- `useCaregiverCallout` - Hook for real-time notifications

### Third-Party Services
- **Twilio** - SMS notifications
- **Resend** - Email delivery
- **Firebase Cloud Messaging** - Push notifications

## Future Enhancements

1. **Geospatial Matching** - Find caregivers within X miles
2. **ML Ranking** - Learn from family preferences over time
3. **Predictive Callout** - Suggest backup before primary cancels
4. **Caregiver Incentives** - Bonus pay for accepting backup shifts

## References

- `functions/src/caregiverCallout.ts`
- `components/CaregiverCalloutModal.tsx`
- `hooks/useCaregiverCallout.ts`
- `TEST_PLAN.md` (testing scenarios)
