import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { safeParseJson } from "../utils/jsonUtils";

const storage = admin.storage();
const db      = admin.firestore();

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
// zepContext: recent conversational memory from Zep (optional, injected by caller)
export async function handleMemoryQuery(
  userId: string,
  chatId: string,
  sendMessage: (id: string, msg: string) => Promise<void>,
  zepContext?: string
): Promise<void> {
  const fileContext = await getMemoryContext(userId);
  const combined    = [fileContext, zepContext ? `## Recent context\n${zepContext}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    await sendMessage(chatId, "I'm still building up my picture of your situation. The more we talk, the more I'll know.");
    return;
  }

  const result = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 220,
    system:
      "You are Cara, a care assistant. Summarize what you know about this family's care situation " +
      "in 2–3 warm, conversational sentences. No bullet points. No headers. Speak as if recounting " +
      "what a trusted friend would remember.",
    messages: [{ role: "user", content: combined }],
  });

  const summary = ((result.content[0] as { text: string }).text ?? "").trim();
  await sendMessage(chatId, summary || "I remember quite a bit — just ask me something specific.");
}

// Consolidate last 7 days of actual conversation messages into memory files.
// `phone` is optional — if omitted, we look it up from agent_sessions using userId.
export async function consolidateMemoryForUser(userId: string, phone?: string): Promise<void> {
  // Resolve phone → agent_conversations doc key
  let conversationKey = phone ?? userId;
  if (!phone) {
    const sessionSnap = await db.collection("agent_sessions")
      .where("userId", "==", userId)
      .limit(1)
      .get();
    if (!sessionSnap.empty) conversationKey = sessionSnap.docs[0].id;
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).getTime();

  const msgSnap = await db
    .collection("agent_conversations")
    .doc(conversationKey)
    .collection("messages")
    .where("timestamp", ">=", sevenDaysAgo)
    .orderBy("timestamp", "asc")
    .limit(60)
    .get();

  if (msgSnap.empty) return;

  const events = msgSnap.docs
    .filter((d) => d.data().role === "user" || d.data().role === "assistant")
    .map((d) => {
      const label   = d.data().role === "user" ? "Family" : "Cara";
      const content = (d.data().content as string | undefined) ?? "";
      return `[${label}]: ${content.slice(0, 600)}`;
    })
    .join("\n");

  if (!events) return;

  const existingContext = await getMemoryContext(userId);

  const result = await getSharedClient().messages.create({
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

  const raw = ((result.content[0] as { text: string }).text ?? "").trim();
  const updates = safeParseJson<Array<{ file: MemoryFile; append: string }>>(
    raw, "memoryFiles.consolidate", [], "array",
  ) ?? [];
  if (updates.length === 0) return;

  const appliedUpdates: Array<{ file: MemoryFile; append: string }> = [];
  for (const { file, append } of updates) {
    if (ALL_FILES.includes(file) && append) {
      await appendToMemoryFile(userId, file, append).catch(() => {});
      appliedUpdates.push({ file, append });
    }
  }

  // Sync applied updates to Zep knowledge graph (fire-and-forget)
  if (appliedUpdates.length > 0 && phone) {
    const zepUserId = phone.replace(/\D/g, "");
    const { addBusinessDataToZep } = await import("./zepClient");
    addBusinessDataToZep({
      userId: zepUserId,
      data: {
        event_type:  "memory_files_consolidated",
        updates:     appliedUpdates.map((u) => ({ file: u.file, content: u.append.slice(0, 400) })),
        timestamp:   new Date().toISOString(),
        data_source: "cara_memory_consolidation",
      },
    }).catch(() => {});
  }

  // Trim recent_episodes.md if it exceeds 8000 chars
  const episodes = await readMemoryFile(userId, "recent_episodes");
  if (episodes.length > 8000) {
    const trimResult = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system:
        "Summarize the oldest entries in this care episode log into a brief paragraph. " +
        "Keep the most recent entries verbatim. Reply with only the revised markdown content.",
      messages: [{ role: "user", content: episodes }],
    });
    const trimmed = ((trimResult.content[0] as { text: string }).text ?? "").trim();
    if (trimmed) {
      await writeMemoryFile(userId, "recent_episodes", trimmed);

      // Keep Zep in sync with the trimmed version so context injection stays consistent.
      if (phone) {
        const zepUserId = phone.replace(/\D/g, "");
        const { addBusinessDataToZep } = await import("./zepClient");
        addBusinessDataToZep({
          userId: zepUserId,
          data: {
            event_type:   "recent_episodes_trimmed",
            content:      trimmed.slice(0, 800),
            timestamp:    new Date().toISOString(),
            data_source:  "cara_memory_trim",
          },
        }).catch(() => {});
      }
    }
  }
}
