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
exports.sendVoiceSummary = sendVoiceSummary;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
// Lazy-loaded to avoid cold-start cost when not used
let _tts = null;
async function getTtsClient() {
    if (!_tts) {
        const { TextToSpeechClient } = await Promise.resolve().then(() => __importStar(require("@google-cloud/text-to-speech")));
        _tts = new TextToSpeechClient();
    }
    return _tts;
}
async function sendVoiceSummary(chatId, summaryText, seniorId) {
    const tts = await getTtsClient();
    const [response] = await tts.synthesizeSpeech({
        input: { text: summaryText },
        voice: {
            languageCode: "en-US",
            name: "en-US-Journey-F",
            ssmlGender: "FEMALE",
        },
        audioConfig: { audioEncoding: "MP3" },
    });
    if (!response.audioContent)
        return;
    // Upload to Firebase Storage
    const bucket = admin.storage().bucket();
    const filePath = `voice_summaries/${seniorId}/${Date.now()}.mp3`;
    const file = bucket.file(filePath);
    await file.save(response.audioContent, {
        metadata: { contentType: "audio/mpeg" },
    });
    // Make publicly readable (temporary signed URL valid 1 hour — Linq fetches it once)
    const [url] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 60 * 60 * 1000,
    });
    await (0, client_1.sendVoiceMemo)(chatId, { url });
}
//# sourceMappingURL=voiceSummary.js.map