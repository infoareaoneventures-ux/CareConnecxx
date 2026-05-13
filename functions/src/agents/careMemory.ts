import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { getMemoryContext } from "../memory/memoryFiles";

const db      = admin.firestore();
const storage = admin.storage();

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

export async function generateCareMemoryKeepsake(
  seniorId: string,
  userId:   string
): Promise<string> {
  // Gather memory files + last 20 journal entries
  const [memoryContext, journalSnap] = await Promise.all([
    getMemoryContext(userId),
    db.collection("care_journal")
      .where("seniorId", "==", seniorId)
      .orderBy("timestamp", "desc")
      .limit(20)
      .get(),
  ]);

  const journalEntries = journalSnap.docs
    .map((d) => {
      const e = d.data();
      const date  = e.timestamp?.slice(0, 10) ?? "unknown date";
      const notes = e.notes ? e.notes.slice(0, 300) : "";
      const mood  = e.wellness?.mood ?? "";
      return `${date}: ${mood ? `Mood ${mood}. ` : ""}${notes}`;
    })
    .join("\n");

  const result = await getClaude().messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 800,
    system:
      "You are writing a warm, compassionate memory keepsake for a family who has lost their loved one. " +
      "Based on the care history below, write a 3–5 paragraph tribute that celebrates the person's life, " +
      "the care they received, and the love surrounding them. " +
      "Tone: warm, personal, comforting — like a loving letter, not a report. " +
      "Do not use bullet points or headers. Write in flowing prose.",
    messages: [{
      role: "user",
      content:
        `Care history:\n${memoryContext}\n\nJournal highlights:\n${journalEntries}`,
    }],
  });

  const keepsake = ((result.content[0] as { text: string }).text ?? "").trim();
  if (!keepsake) return "";

  // Save to Firebase Storage
  const path    = `keepsakes/${userId}/care_memory.md`;
  const bucket  = storage.bucket();
  await bucket.file(path).save(keepsake, {
    contentType: "text/markdown",
    metadata:    { cacheControl: "no-cache" },
  });

  // Generate signed URL (7-day access)
  const [url] = await bucket.file(path).getSignedUrl({
    action:  "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  return url;
}
