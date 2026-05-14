import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";

const storage = admin.storage();
const db      = admin.firestore();

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

export type MemoryFile = "profile" | "health" | "family" | "recent_episodes" | "procedural";

const ALL_FILES: MemoryFile[] = ["profile", "health", "family", "recent_episodes", "procedural"];

function filePath(userId: string, file: MemoryFile): string {
  return `memory/${userId}/${file}.md`;
}

export async function readMemoryFile(userId: string, file: MemoryFile): Promise<string> {
  try {
    const bucket = storage.bucket();
    const [contents] = await bucket.file(filePath(userId, file)).download();
    return contents.toString("utf-8");
  } catch {
    return "";
  }
}

export async function writeMemoryFile(
  userId: string,
  file: MemoryFile,
  content: string
): Promise<void> {
  const bucket = storage.bucket();
  await bucket.file(filePath(userId, file)).save(content, {
    contentType: "text/markdown",
    metadata:    { cacheControl: "no-cache" },
  });
}

export async function appendToMemoryFile(
  userId: string,
  file: MemoryFile,
  entry: string
): Promise<void> {
  const existing = await readMemoryFile(userId, file);
  const updated  = existing
    ? `${existing.trimEnd()}\n\n${entry}`
    : entry;
  await writeMemoryFile(userId, file, updated);
}

// Returns all 5 files concatenated, trimmed to ~3000 tokens (~12 000 chars)
export async function getMemoryContext(userId: string): Promise<string> {
  const parts = await Promise.all(
    ALL_FILES.map(async (file) => {
      const content = await readMemoryFile(userId, file);
      return content ? `## ${file}\n${content}` : "";
    })
  );

  const combined = parts.filter(Boolean).join("\n\n");
  if (combined.length <= 12000) return combined;
  return combined.slice(0, 12000) + "\n\n[Memory truncated for length]";
}

export interface InitialMemoryData {
  seniorName?:   string;
  seniorAge?:    string | number;
  conditions?:   string | string[];
  careNeeds?:    string | string[];
  city?:         string;
  clientName?:   string;
  relationship?: string;
}

export async function initializeMemoryFiles(
  userId: string,
  data:   InitialMemoryData
): Promise<void> {
  const seniorName   = data.seniorName   ?? "your loved one";
  const clientName   = data.clientName   ?? "";
  const relationship = data.relationship ?? "family member";
  const conditions   = Array.isArray(data.conditions)
    ? data.conditions.join(", ")
    : (data.conditions ?? "none noted");
  const careNeeds = Array.isArray(data.careNeeds)
    ? data.careNeeds.join(", ")
    : (data.careNeeds ?? "general support");

  const profileMd =
    `# Profile\n\n` +
    `**Senior:** ${seniorName}${data.seniorAge ? `, age ${data.seniorAge}` : ""}\n` +
    `**Primary contact:** ${clientName} (${relationship})\n` +
    `**Location:** ${data.city ?? "unknown"}\n` +
    `**Care needs:** ${careNeeds}\n`;

  const healthMd =
    `# Health\n\n` +
    `**Conditions:** ${conditions}\n` +
    `**Medications:** unknown\n` +
    `**Allergies:** unknown\n`;

  await Promise.all([
    writeMemoryFile(userId, "profile", profileMd),
    writeMemoryFile(userId, "health", healthMd),
  ]);
}

// Triggered when user asks "what do you know about mom?" (or similar)
export async function handleMemoryQuery(
  userId: string,
  chatId: string,
  sendMessage: (id: string, msg: string) => Promise<void>
): Promise<void> {
  const context = await getMemoryContext(userId);
  if (!context) {
    await sendMessage(chatId, "I'm still learning about your care situation — the more we talk, the more I'll remember! 💙");
    return;
  }

  const result = await getClaude().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system:
      "You are Cara, a care assistant. Summarize what you know about this family's care situation " +
      "in 2–3 warm, conversational sentences. No bullet points. No headers. Speak as if recounting " +
      "what a trusted friend would remember.",
    messages: [{ role: "user", content: context }],
  });

  const summary = ((result.content[0] as { text: string }).text ?? "").trim();
  await sendMessage(chatId, summary || "I remember quite a bit — just ask me something specific! 💙");
}

// Consolidate last 48h of audit log entries into memory files
export async function consolidateMemoryForUser(userId: string): Promise<void> {
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const logSnap = await db
    .collection("agent_audit_log")
    .where("userId", "==", userId)
    .where("timestamp", ">=", fortyEightHoursAgo)
    .orderBy("timestamp", "asc")
    .limit(50)
    .get();

  if (logSnap.empty) return;

  const events = logSnap.docs
    .map((d) => d.data())
    .filter((e) => e.eventType === "message_sent" || e.eventType === "message_received")
    .map((e) => `[${e.timestamp}] ${e.eventType}: ${JSON.stringify(e.data).slice(0, 200)}`)
    .join("\n");

  if (!events) return;

  const existingContext = await getMemoryContext(userId);

  const result = await getClaude().messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 600,
    system:
      "You maintain memory files for a caregiving AI assistant named Cara. " +
      "Based on recent conversation events, extract new facts and decide which memory files to update. " +
      "Memory files: profile (identity/contact prefs), health (diagnoses/meds/allergies), " +
      "family (relationships/dynamics), recent_episodes (last 30 days events), procedural (routines). " +
      "Reply with JSON: [{\"file\": \"<type>\", \"append\": \"<markdown to append>\"}]. " +
      "Only include files that need updating. Keep appended content concise (1–3 lines each).",
    messages: [{
      role: "user",
      content: `Existing memory:\n${existingContext}\n\nRecent events:\n${events}`,
    }],
  });

  let updates: Array<{ file: MemoryFile; append: string }> = [];
  try {
    updates = JSON.parse((result.content[0] as { text: string }).text ?? "[]");
  } catch {
    return;
  }

  for (const { file, append } of updates) {
    if (ALL_FILES.includes(file) && append) {
      await appendToMemoryFile(userId, file, append).catch(() => {});
    }
  }

  // Trim recent_episodes.md if it exceeds 8000 chars
  const episodes = await readMemoryFile(userId, "recent_episodes");
  if (episodes.length > 8000) {
    const trimResult = await getClaude().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system:
        "Summarize the oldest entries in this care episode log into a brief paragraph. " +
        "Keep the most recent entries verbatim. Reply with only the revised markdown content.",
      messages: [{ role: "user", content: episodes }],
    });
    const trimmed = ((trimResult.content[0] as { text: string }).text ?? "").trim();
    if (trimmed) await writeMemoryFile(userId, "recent_episodes", trimmed);
  }
}
