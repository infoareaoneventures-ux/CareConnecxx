import * as admin from "firebase-admin";
import { sendVoiceMemo } from "../linq/client";

// Lazy-loaded to avoid cold-start cost when not used
let _tts: any = null;
async function getTtsClient() {
  if (!_tts) {
    const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
    _tts = new TextToSpeechClient();
  }
  return _tts;
}

export async function sendVoiceSummary(
  chatId:      string,
  summaryText: string,
  seniorId:    string
): Promise<void> {
  const tts = await getTtsClient();

  const [response] = await tts.synthesizeSpeech({
    input: { text: summaryText },
    voice: {
      languageCode: "en-US",
      name:         "en-US-Journey-F",
      ssmlGender:   "FEMALE",
    },
    audioConfig: { audioEncoding: "MP3" },
  });

  if (!response.audioContent) return;

  // Upload to Firebase Storage
  const bucket   = admin.storage().bucket();
  const filePath = `voice_summaries/${seniorId}/${Date.now()}.mp3`;
  const file     = bucket.file(filePath);

  await file.save(response.audioContent as Buffer, {
    metadata: { contentType: "audio/mpeg" },
  });

  // Make publicly readable (temporary signed URL valid 1 hour — Linq fetches it once)
  const [url] = await file.getSignedUrl({
    action:  "read",
    expires: Date.now() + 60 * 60 * 1000,
  });

  await sendVoiceMemo(chatId, url);
}
