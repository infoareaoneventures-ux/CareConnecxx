"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTwilioToken = void 0;
const functions = __importStar(require("firebase-functions"));
const twilio_1 = require("twilio");
const { AccessToken } = twilio_1.jwt;
const { VideoGrant } = AccessToken;
/**
 * Cloud Function to generate Twilio access tokens for video calls
 * This keeps Twilio credentials secure on the server side
 */
exports.generateTwilioToken = functions.https.onCall(async (data, context) => {
    // Verify user is authenticated
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated to generate video tokens');
    }
    const { identity, roomName } = data;
    // Validate inputs
    if (!identity || typeof identity !== 'string') {
        throw new functions.https.HttpsError('invalid-argument', 'Identity is required and must be a string');
    }
    if (!roomName || typeof roomName !== 'string') {
        throw new functions.https.HttpsError('invalid-argument', 'Room name is required and must be a string');
    }
    // Get Twilio credentials from server-side environment variables
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
    if (!accountSid || !apiKeySid || !apiKeySecret) {
        console.error('Twilio credentials not configured on server');
        throw new functions.https.HttpsError('internal', 'Video service not properly configured');
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
    }
    catch (error) {
        console.error('Error generating Twilio token:', error);
        throw new functions.https.HttpsError('internal', 'Failed to generate video token');
    }
});
//# sourceMappingURL=twilio.js.map