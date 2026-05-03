import * as functions from 'firebase-functions';
import { jwt } from 'twilio';

const { AccessToken } = jwt;
const { VideoGrant } = AccessToken;

/**
 * Cloud Function to generate Twilio access tokens for video calls
 * This keeps Twilio credentials secure on the server side
 */
export const generateTwilioToken = functions.https.onCall(async (data, context) => {
  // Verify user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'User must be authenticated to generate video tokens'
    );
  }

  const { identity, roomName } = data;

  // Validate inputs
  if (!identity || typeof identity !== 'string') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Identity is required and must be a string'
    );
  }

  if (!roomName || typeof roomName !== 'string') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Room name is required and must be a string'
    );
  }

  // Get Twilio credentials from server-side environment variables
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;

  if (!accountSid || !apiKeySid || !apiKeySecret) {
    console.error('Twilio credentials not configured on server');
    throw new functions.https.HttpsError(
      'internal',
      'Video service not properly configured'
    );
  }

  try {
    // Create a video grant for the room
    const videoGrant = new VideoGrant({
      room: roomName,
    });

    // Create access token
    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity,
      ttl: 3600, // 1 hour expiration
    });

    token.addGrant(videoGrant);

    // Generate the token string
    const tokenString = token.toJwt();

    console.log(`✅ Generated Twilio token for user: ${identity}, room: ${roomName}`);

    return {
      token: tokenString,
      roomName,
      identity,
      expiresIn: 3600,
    };
  } catch (error) {
    console.error('Error generating Twilio token:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Failed to generate video token'
    );
  }
});
