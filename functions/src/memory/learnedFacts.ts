import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";

const db = admin.firestore();

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

export type FactCategory = "medical" | "preference" | "routine" | "family";

export interface LearnedFact {
  userId: string;
  fact: string;
  weight: number;           // 1–10; increments on re-mention
  category: FactCategory;
  createdAt: string;
  lastMentionedAt: string;
}

// Normalize a fact string for deduplication comparison
function normalizeFact(fact: string): string {
  return fact.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function extractAndStoreFacts(userId: string, text: string): Promise<void> {
  if (!text || text.length < 10) return;

  let extracted: Array<{ fact: string; category: FactCategory }> = [];
  try {
    const result = await getClaude().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:
        "Extract persistent, reusable facts about the user's care situation from this message. " +
        "Categories: medical (diagnoses, meds, allergies), preference (likes/dislikes, habits), " +
        "routine (schedule, recurring activities), family (relationships, names). " +
        "Only extract facts that are clearly stated and would be useful in future conversations. " +
        "Reply with only a JSON array: [{\"fact\": \"...\", \"category\": \"medical|preference|routine|family\"}]. " +
        "Return [] if nothing worth storing.",
      messages: [{ role: "user", content: text }],
    });
    extracted = JSON.parse((result.content[0] as { text: string }).text ?? "[]");
  } catch {
    return; // Non-critical — don't throw
  }

  if (!Array.isArray(extracted) || extracted.length === 0) return;

  const factsCol = db.collection("learned_facts").doc(userId).collection("facts");
  const nowIso   = new Date().toISOString();

  for (const item of extracted) {
    if (!item.fact || !item.category) continue;
    const norm = normalizeFact(item.fact);

    // Check for existing fact with same normalized text
    const existing = await factsCol
      .where("_norm", "==", norm)
      .limit(1)
      .get();

    if (!existing.empty) {
      const doc = existing.docs[0];
      const currentWeight = doc.data().weight ?? 1;
      await doc.ref.update({
        weight:          Math.min(currentWeight + 1, 10),
        lastMentionedAt: nowIso,
      });
    } else {
      await factsCol.add({
        userId,
        fact:            item.fact,
        _norm:           norm,
        weight:          1,
        category:        item.category,
        createdAt:       nowIso,
        lastMentionedAt: nowIso,
      } satisfies LearnedFact & { _norm: string });
    }
  }
}

export async function getRelevantFacts(
  userId: string,
  _topic?: string
): Promise<LearnedFact[]> {
  const snap = await db
    .collection("learned_facts")
    .doc(userId)
    .collection("facts")
    .orderBy("weight", "desc")
    .limit(10)
    .get();

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      userId:          data.userId,
      fact:            data.fact,
      weight:          data.weight,
      category:        data.category,
      createdAt:       data.createdAt,
      lastMentionedAt: data.lastMentionedAt,
    } as LearnedFact;
  });
}
