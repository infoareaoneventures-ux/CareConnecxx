# Firebase Cloud Messaging (FCM) Setup

## Status: ✅ CONFIGURED

Your Firebase VAPID key has been integrated into the CareConnex push notification system.

---

## What's Been Set Up

### 1. Environment Variables
The VAPID key has been added to:
- `.env` (development)
- `.env.production` (production build)

```
VITE_FIREBASE_VAPID_KEY=5AV6k1a1NPrJq__sQ5D0EjEY1IIW_HTlHzsrlc8UEjA
```

### 2. Frontend Service (`services/pushNotificationService.ts`)
- Initializes Firebase Cloud Messaging
- Requests browser notification permission
- Registers FCM tokens with the VAPID key
- Saves tokens to user's Firestore document (`users/{userId}.fcmTokens[]`)
- Handles foreground notifications
- Supports topic subscriptions

### 3. React Hook (`hooks/usePushNotifications.ts`)
```typescript
const { 
  permission, 
  initialize, 
  requestPermission,
  subscribeToTopic,
  sendTest 
} = usePushNotifications(userId);
```

### 4. Service Worker (`public/firebase-messaging-sw.js`)
- Handles background push notifications
- Shows notification when app is closed/minimized
- Handles notification clicks (opens app to relevant page)
- Supports action buttons (Open, Dismiss)

### 5. Cloud Functions (`functions/src/pushNotifications.js`)
**Automatic triggers:**
- `sendPushNotification` - Fires on new chat messages
- `sendAppointmentReminder` - Callable for appointment alerts
- `subscribeToTopic` - Subscribe users to broadcast topics
- `sendBroadcast` - Admin-only topic broadcasts

---

## How to Use

### Enable Push Notifications (in a component)
```typescript
import { usePushNotifications } from '@/hooks/usePushNotifications';

function NotificationSettings({ userId }) {
  const { permission, requestPermission, isSupported } = usePushNotifications(userId);

  if (!isSupported) return <p>Notifications not supported</p>;

  return (
    <button onClick={requestPermission}>
      {permission === 'granted' ? '✅ Enabled' : 'Enable Notifications'}
    </button>
  );
}
```

### Auto-initialize on Login
Add to your auth flow:
```typescript
useEffect(() => {
  if (user?.uid) {
    pushNotificationService.initialize(user.id);
  }
}, [user]);
```

### Send a Test Notification
```typescript
const { sendTest } = usePushNotifications(userId);
// Call sendTest() to trigger a test push
```

---

## Data Structure

User document stores FCM tokens:
```javascript
// Firestore: users/{userId}
{
  fcmTokens: [
    "dBzYz...:APA91bH...",  // Device 1
    "fX2Kp...:APA91bM..."   // Device 2
  ]
}
```

---

## Notification Types

### 1. Chat Messages
- Trigger: New message in `chatRooms/{id}/messages`
- Title: "New message from {senderName}"
- Click: Opens inbox

### 2. Appointment Reminders
- Trigger: Callable function or scheduled job
- Title: Custom (e.g., "Upcoming Appointment")
- Click: Opens appointments page

### 3. Broadcasts (Admin)
- Trigger: Admin calls `sendBroadcast`
- Topic-based subscription model
- Use for: App updates, announcements

---

## Security Notes

1. **VAPID Key**: The key you provided is the public key. Firebase manages the private key internally.

2. **Token Management**: Invalid tokens are automatically removed when FCM returns errors.

3. **Permission**: Users must explicitly grant notification permission (browser requirement).

4. **HTTPS Required**: Push notifications only work on HTTPS (or localhost for development).

---

## Testing

1. **Local Testing**:
   ```bash
   npm run dev
   # Visit https://localhost:5173 (or your dev URL)
   # Accept notification permission
   # Click "Send Test Notification"
   ```

2. **Production Testing**:
   - Deploy: `firebase deploy`
   - Visit production URL
   - Accept permission
   - Test with real chat message

3. **Check Console**:
   - Open DevTools → Application → Service Workers
   - Verify `firebase-messaging-sw.js` is registered
   - Check Console for FCM token logs

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No permission prompt | Check browser notification settings |
| Token not saving | Verify user is authenticated |
| Background notifications not working | Check service worker registration |
| Notifications not received | Verify FCM token in Firestore |
| iOS not working | FCM web push requires iOS 16.4+ |

---

## Next Steps

1. **Deploy the functions** (if not already):
   ```bash
   cd functions
   npm run deploy
   ```

2. **Add UI for notification preferences** in user settings

3. **Test on multiple devices** (desktop, mobile, different browsers)

4. **Consider adding**:
   - Notification preference settings (toggle types)
   - Quiet hours / Do Not Disturb
   - Rich notifications with images

---

## Reference

- [Firebase FCM Docs](https://firebase.google.com/docs/cloud-messaging)
- [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Notification API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
