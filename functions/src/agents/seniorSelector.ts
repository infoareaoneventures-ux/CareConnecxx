import * as admin from "firebase-admin";

const db = admin.firestore();

export interface SeniorSummary {
  seniorId: string;
  name: string;
  age?: number;
}

/**
 * Returns all seniors for a given client.
 * Tries the new model first (senior_profiles.clientId == clientId),
 * then falls back to the old 1:1 model (senior_profiles/{clientId}).
 */
export async function getSeniorsForClient(clientId: string): Promise<SeniorSummary[]> {
  // New model: query by clientId field
  const snap = await db.collection("senior_profiles")
    .where("clientId", "==", clientId)
    .limit(10)
    .get();

  if (!snap.empty) {
    return snap.docs.map(d => ({
      seniorId: d.id,
      name: (d.data().name as string) ?? "Unknown",
      age: d.data().age as number | undefined,
    }));
  }

  // Old model fallback: clientId === seniorId
  const single = await db.collection("senior_profiles").doc(clientId).get();
  if (single.exists) {
    return [{
      seniorId: clientId,
      name: (single.data()?.name as string) ?? "Unknown",
      age: single.data()?.age as number | undefined,
    }];
  }

  return [];
}

/**
 * Returns a prompt asking the client which senior this conversation is about,
 * or an empty string if there's only one senior (no selection needed).
 */
export function formatSeniorSelectionMessage(seniors: SeniorSummary[]): string {
  if (seniors.length === 0) {
    return "I don't have a senior profile on file yet. Can you tell me who I'll be helping care for?";
  }
  if (seniors.length === 1) {
    return "";
  }
  const list = seniors
    .map((s, i) => `${i + 1}. ${s.name}${s.age ? ` (${s.age})` : ""}`)
    .join("\n");
  return `Who is this for?\n${list}`;
}
