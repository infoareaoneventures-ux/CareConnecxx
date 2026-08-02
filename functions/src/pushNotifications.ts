import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// Initialize admin if not already done
if (!admin.apps.length) {
  admin.initializeApp();
}

/**
 * Send push notification to a user
 * Triggered when a new message is created
 */
export const sendPushNotification = functions.firestore
  .document("chatRooms/{chatRoomId}/messages/{messageId}")
  .onCreate(async (snap, context) => {
    const message = snap.data();
    const { chatRoomId } = context.params;

    // Don't send push for system messages
    if (message.type === "system") return null;

    try {
      // Get chat room details
      const chatRoomDoc = await admin
        .firestore()
        .collection("chatRooms")
        .doc(chatRoomId)
        .get();

      if (!chatRoomDoc.exists) return null;

      const chatRoom = chatRoomDoc.data();
      const participants = chatRoom?.participants || [];

      // Find recipient (not the sender)
      const senderId = message.senderId;
      const recipientId = participants.find((id: string) => id !== senderId);

      if (!recipientId) return null;

      // ── Childcare U9 (plan 2026-07-22-002, R43/KTD16/AE17/AE24) ──────────
      // Childcare context rooms get a FULLY GENERIC lock-screen payload:
      // static registry title/body, NO message text, NO sender name, opaque
      // room id only — detail is fetched inside authenticated views. The
      // fan-out also consults the booking's excludedUids set (suspected-
      // unsafe-party exclusion): an excluded recipient gets NO push. Any
      // uncertainty (booking unreadable) fails CLOSED to no push. Senior
      // rooms below are byte-identical to their pre-U9 behavior.
      const isChildcareRoom = chatRoom?.careVertical === "child";
      if (isChildcareRoom) {
        try {
          const {
            evaluateChildcarePushContext,
            getChildcareNotificationTemplate,
          } = await import(
            "./childcare/notificationPolicy"
          );
          if (chatRoom?.contextType !== "booking" || !chatRoom?.contextId) return null;
          const bookingSnap = await admin
            .firestore()
            .collection("booking_requests")
            .doc(String(chatRoom.contextId))
            .get();
          const decision = evaluateChildcarePushContext({
            roomId: chatRoomId,
            room: chatRoom ?? {},
            message: message ?? {},
            booking: bookingSnap.exists ? bookingSnap.data() ?? {} : null,
            recipientUid: recipientId,
          });
          if (!decision.allowed) {
            console.warn("Childcare push suppressed", {
              reason: decision.reason,
              roomId: chatRoomId,
            });
            return null;
          }
          const template = getChildcareNotificationTemplate("childcare_message");
          const genericNotification = {
            title: template.title,
            body: template.body,
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            tag: chatRoomId,
            requireInteraction: false,
            data: { chatRoomId, click_action: "/inbox" },
          };
          return await sendPushToUserTokens(recipientId, genericNotification);
        } catch (error) {
          console.error("Error sending childcare push (fail closed, no push):", error);
          return null;
        }
      }

      // Prepare notification (senior payload — byte-identical to pre-U9)
      const senderName = message.senderName || "Evia";
      const notification = {
        title: `New message from ${senderName}`,
        body:
          message.text.length > 100
            ? message.text.substring(0, 97) + "..."
            : message.text,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: chatRoomId,
        requireInteraction: false,
        data: {
          chatRoomId,
          senderId,
          senderName,
          messageId: context.params.messageId,
          click_action: "/inbox",
        },
      };

      return await sendPushToUserTokens(recipientId, notification);
    } catch (error: any) {
      console.error("Error sending push notification:", error);
      return { success: false, error: error.message };
    }
  });

/**
 * Send one prepared web-push notification to every FCM token of a user.
 * Extracted (behavior-preserving) so the childcare U9 generic branch and the
 * senior branch share exactly one delivery path.
 */
async function sendPushToUserTokens(
  recipientId: string,
  notification: {
    title: string;
    body: string;
    icon: string;
    badge?: string;
    tag?: string;
    requireInteraction?: boolean;
    data?: Record<string, string>;
  }
) {
  // Get recipient's FCM tokens
  const userDoc = await admin
    .firestore()
    .collection("users")
    .doc(recipientId)
    .get();

  if (!userDoc.exists) return null;

  const userData = userDoc.data();
  const fcmTokens: string[] = userData?.fcmTokens || [];

  if (fcmTokens.length === 0) {
    console.log(`No FCM tokens for user ${recipientId}`);
    return null;
  }

  // Send to all tokens (user might have multiple devices)
  const sendPromises = fcmTokens.map(async (token: string) => {
    try {
      await admin.messaging().send({
        token,
        notification,
        android: {
          priority: "high",
          notification: {
            channelId: "chat-messages",
            priority: "high",
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
              alert: {
                title: notification.title,
                body: notification.body,
              },
            },
          },
        },
      });
      return { success: true, token };
    } catch (error: any) {
      // If token is invalid, remove it
      if (
        error.code === "messaging/invalid-registration-token" ||
        error.code === "messaging/registration-token-not-registered"
      ) {
        console.log(`Removing invalid token for user ${recipientId}`);
        await removeInvalidToken(recipientId, token);
      }
      return { success: false, token, error: error.message };
    }
  });

  const results = await Promise.all(sendPromises);
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(
    `Push notification sent: ${successful} successful, ${failed} failed`
  );

  return { success: true, sent: successful, failed };
}

/**
 * Send push notification for appointment reminders
 */
export const sendAppointmentReminder = functions.https.onCall(
  async (data, context) => {
    // Verify authentication
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    const { userId, title, body, appointmentId } = data;

    if (!userId || !title || !body) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing required fields"
      );
    }

    try {
      // Get user's FCM tokens
      const userDoc = await admin
        .firestore()
        .collection("users")
        .doc(userId)
        .get();

      if (!userDoc.exists) {
        throw new functions.https.HttpsError("not-found", "User not found");
      }

      const userData = userDoc.data();
      const fcmTokens: string[] = userData?.fcmTokens || [];

      if (fcmTokens.length === 0) {
        return { success: false, message: "No FCM tokens for user" };
      }

      const notification = {
        title,
        body,
        icon: "/icon-192.png",
        data: {
          appointmentId,
          click_action: "/appointments",
        },
      };

      // Send to all tokens
      const sendPromises = fcmTokens.map((token) =>
        admin
          .messaging()
          .send({
            token,
            notification,
            android: { priority: "high" },
            apns: { payload: { aps: { sound: "default" } } },
          })
          .catch((error) => {
            console.error(`Failed to send to token ${token}:`, error);
            return null;
          })
      );

      await Promise.all(sendPromises);

      return { success: true, message: "Notification sent" };
    } catch (error: any) {
      console.error("Error sending appointment reminder:", error);
      throw new functions.https.HttpsError("internal", error.message);
    }
  }
);

/**
 * Remove invalid FCM token from user's token list
 */
async function removeInvalidToken(userId: string, invalidToken: string) {
  try {
    const userRef = admin.firestore().collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return;

    const userData = userDoc.data();
    const tokens: string[] = userData?.fcmTokens || [];

    // Remove invalid token
    const updatedTokens = tokens.filter((t) => t !== invalidToken);

    if (updatedTokens.length !== tokens.length) {
      await userRef.update({ fcmTokens: updatedTokens });
      console.log(`Removed invalid token for user ${userId}`);
    }
  } catch (error) {
    console.error("Error removing invalid token:", error);
  }
}

/**
 * Subscribe user to topic (for broadcast notifications)
 */
export const subscribeToTopic = functions.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    const { token, topic } = data;

    if (!token || !topic) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Token and topic required"
      );
    }

    try {
      await admin.messaging().subscribeToTopic(token, topic);
      return { success: true, message: `Subscribed to ${topic}` };
    } catch (error: any) {
      console.error("Error subscribing to topic:", error);
      throw new functions.https.HttpsError("internal", error.message);
    }
  }
);

/**
 * Send broadcast notification to topic
 */
export const sendBroadcast = functions.https.onCall(async (data, context) => {
  // Only admins can send broadcasts
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "User must be authenticated"
    );
  }

  // Check if user is admin
  const userDoc = await admin
    .firestore()
    .collection("users")
    .doc(context.auth.uid)
    .get();
  const userData = userDoc.data();

  if (!userData || userData.role !== "admin") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only admins can send broadcasts"
    );
  }

  const { topic, title, body } = data;

  if (!topic || !title || !body) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Missing required fields"
    );
  }

  try {
    const message: admin.messaging.TopicMessage = {
      topic,
      notification: {
        title,
        body,
      },
      android: { priority: "high" as const },
      apns: { payload: { aps: { sound: "default" } } },
    };

    await admin.messaging().send(message);
    return { success: true, message: "Broadcast sent" };
  } catch (error: any) {
    console.error("Error sending broadcast:", error);
    throw new functions.https.HttpsError("internal", error.message);
  }
});
