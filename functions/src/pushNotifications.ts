import * as functions from "firebase-functions";
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

      // Prepare notification
      const senderName = message.senderName || "CareConnex";
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
    } catch (error: any) {
      console.error("Error sending push notification:", error);
      return { success: false, error: error.message };
    }
  });

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
