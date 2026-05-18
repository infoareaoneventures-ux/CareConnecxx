import * as admin from "firebase-admin";
import * as crypto from "crypto";

const db = admin.firestore();

const ALGORITHM  = "aes-256-gcm";
const IV_LENGTH  = 16;

// Patient portals, pharmacies, and insurance member portals Cara can log into
export type PortalService =
  | "mychart"
  | "athenahealth"
  | "followmyhealth"
  | "cvs"
  | "walgreens"
  | "riteaid"
  | "caremark"
  | "express_scripts"
  | "aetna"
  | "unitedhealthcare"
  | "humana"
  | "cigna"
  | "medicare"
  | "medicaid";

// Map common insurer name strings → PortalService keys
export const INSURER_KEY_MAP: Record<string, PortalService> = {
  aetna:             "aetna",
  "united healthcare": "unitedhealthcare",
  unitedhealthcare:  "unitedhealthcare",
  uhc:               "unitedhealthcare",
  humana:            "humana",
  cigna:             "cigna",
  medicare:          "medicare",
  medicaid:          "medicaid",
};

export function insurerToServiceKey(insurer: string): PortalService {
  const lower = insurer.toLowerCase().trim();
  return INSURER_KEY_MAP[lower] ?? (lower.replace(/[^a-z]/g, "") as PortalService);
}

// ── Encryption helpers ────────────────────────────────────────────────────────

function getVaultKey(): Buffer {
  const key = process.env.CREDENTIAL_VAULT_KEY;
  if (!key) throw new Error("CREDENTIAL_VAULT_KEY not set");
  if (key.length !== 64) throw new Error("CREDENTIAL_VAULT_KEY must be 64 hex chars (32 bytes)");
  return Buffer.from(key, "hex");
}

export function encryptPassword(plaintext: string): {
  encrypted: string;
  ivHex:     string;
  tagHex:    string;
} {
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getVaultKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    encrypted: encrypted.toString("hex"),
    ivHex:     iv.toString("hex"),
    tagHex:    cipher.getAuthTag().toString("hex"),
  };
}

export function decryptPassword(
  encryptedHex: string,
  ivHex:        string,
  tagHex:       string
): string {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getVaultKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// ── CRUD operations ───────────────────────────────────────────────────────────

export async function storeCredential(
  userId:   string,
  service:  PortalService,
  username: string,
  password: string,
  options?: { portalUrl?: string; notes?: string }
): Promise<void> {
  const { encrypted, ivHex, tagHex } = encryptPassword(password);

  await db.collection("credential_vault")
    .doc(`${userId}_${service}`)
    .set({
      userId,
      service,
      username,
      passwordEncrypted: encrypted,
      ivHex,
      tagHex,
      portalUrl:         options?.portalUrl ?? null,
      notes:             options?.notes     ?? null,
      storedAt:          new Date().toISOString(),
      lastUsedAt:        null,
      lastUsedSuccess:   null,
    });
}

export async function getCredential(
  userId:  string,
  service: PortalService
): Promise<{ username: string; password: string; portalUrl?: string } | null> {
  const snap = await db.collection("credential_vault")
    .doc(`${userId}_${service}`)
    .get();

  if (!snap.exists) return null;

  const data = snap.data()!;
  try {
    const password = decryptPassword(
      data.passwordEncrypted,
      data.ivHex,
      data.tagHex
    );
    await snap.ref.update({ lastUsedAt: new Date().toISOString() });
    return {
      username:  data.username,
      password,
      portalUrl: data.portalUrl ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function hasCredential(
  userId:  string,
  service: PortalService
): Promise<boolean> {
  const snap = await db.collection("credential_vault")
    .doc(`${userId}_${service}`)
    .get();
  return snap.exists;
}

export async function deleteCredential(
  userId:  string,
  service: PortalService
): Promise<void> {
  await db.collection("credential_vault")
    .doc(`${userId}_${service}`)
    .delete();
}

export async function listCredentials(
  userId: string
): Promise<Array<{ service: PortalService; username: string; notes?: string }>> {
  const snap = await db.collection("credential_vault")
    .where("userId", "==", userId)
    .get();

  return snap.docs.map(d => ({
    service:  d.data().service  as PortalService,
    username: d.data().username as string,
    notes:    d.data().notes    as string | undefined,
  }));
}

export async function markCredentialUsed(
  userId:  string,
  service: PortalService,
  success: boolean
): Promise<void> {
  try {
    await db.collection("credential_vault")
      .doc(`${userId}_${service}`)
      .update({
        lastUsedAt:      new Date().toISOString(),
        lastUsedSuccess: success,
      });
  } catch {
    // Doc may not exist — ignore
  }
}
