// Anthropic Agent Skills catalog — file-based skill packs Evia reads from
// `functions/src/skills/<name>/SKILL.md`. Each SKILL.md follows the Anthropic
// Skills spec: YAML frontmatter (name + description) + Markdown body.
//
// Why this layer? Before this, "Evia should do X when Y" lived as inline
// system-prompt text in qaAgent.ts. That doesn't scale — three more triggers
// and the prompt becomes a wall. Skills move those triggers into discrete,
// reviewable files keyed by description so the picker can match them.
//
// Progressive disclosure (per the spec):
//   1. Metadata (name + description) is ALWAYS in the picker's view (~100w).
//   2. Body is loaded ONLY when the skill triggers (<5k words).
//   3. Bundled resources (scripts/, references/, assets/) come later if needed.
//
// This module owns layer (1) + (2). The picker (skillPicker.ts) decides which
// skill fires; the body injection lives in qaAgent.ts.

import fs   from "fs";
import path from "path";

export interface SkillMetadata {
  name:        string;
  description: string;
}

export interface SkillDefinition extends SkillMetadata {
  /** Markdown body — loaded once at startup and cached. */
  body: string;
}

// Spec limits — enforced at load time so a bad skill file fails fast in tests
// rather than at runtime when Sonnet is waiting.
const NAME_MAX_LEN        = 64;
const DESCRIPTION_MAX_LEN = 1024;
const BODY_MAX_LEN        = 50_000; // ~5k words guidance from the spec
const NAME_RE             = /^[a-z][a-z0-9-]*$/;

// Frontmatter parser. Anthropic Skills frontmatter is intentionally restricted:
// we only need `name` (required) and `description` (required). The spec also
// allows license, compatibility, allowed-tools, metadata — we ignore those for
// now and add real support when a skill actually needs them.
//
// Format:
//   ---
//   name: skill-name
//   description: "Single-line OR multi-line description"
//   ---
//   <markdown body>
//
// We hand-roll the parser because the YAML surface is tiny and a real YAML
// dependency for two fields is overkill. If we ever need richer frontmatter,
// drop in js-yaml or gray-matter — the interface here stays the same.
export function parseSkillFile(raw: string): SkillDefinition {
  // Normalize CRLF → LF before scanning so Windows-checked-in files don't
  // throw the regex off. The body is preserved as-is for downstream rendering.
  const text = raw.replace(/\r\n/g, "\n");

  if (!text.startsWith("---\n")) {
    throw new Error("SKILL.md must start with a YAML frontmatter delimiter (---)");
  }

  const endIdx = text.indexOf("\n---\n", 4);
  if (endIdx < 0) {
    throw new Error("SKILL.md frontmatter is not terminated by a second ---");
  }

  const frontmatter = text.slice(4, endIdx);
  const body        = text.slice(endIdx + 5).trim();

  const meta = parseFrontmatterFields(frontmatter);

  if (!meta.name) {
    throw new Error("SKILL.md frontmatter is missing required field: name");
  }
  if (!meta.description) {
    throw new Error("SKILL.md frontmatter is missing required field: description");
  }

  if (meta.name.length > NAME_MAX_LEN) {
    throw new Error(`SKILL.md name "${meta.name}" exceeds ${NAME_MAX_LEN} chars`);
  }
  if (!NAME_RE.test(meta.name)) {
    throw new Error(`SKILL.md name "${meta.name}" must be hyphen-case (a-z, 0-9, -)`);
  }
  if (meta.description.length > DESCRIPTION_MAX_LEN) {
    throw new Error(`SKILL.md description exceeds ${DESCRIPTION_MAX_LEN} chars`);
  }
  if (body.length === 0) {
    throw new Error(`SKILL.md "${meta.name}" has an empty body`);
  }
  if (body.length > BODY_MAX_LEN) {
    throw new Error(`SKILL.md "${meta.name}" body exceeds ${BODY_MAX_LEN} chars (~5k words)`);
  }

  return { name: meta.name, description: meta.description, body };
}

interface RawFrontmatter {
  name?:        string;
  description?: string;
}

function parseFrontmatterFields(yaml: string): RawFrontmatter {
  // Skills frontmatter supports two value shapes for `description`:
  //   description: simple single-line value
  //   description: "quoted string with potentially embedded colons"
  // We don't support YAML block scalars (|, >) yet — keep the parser tight.
  const out: RawFrontmatter = {};
  for (const line of yaml.split("\n")) {
    const m = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();

    if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\n/g, "\n");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }

    if (key === "name")        out.name        = value;
    if (key === "description") out.description = value;
  }
  return out;
}

/**
 * Resolve the skills directory. Works both when running TS source directly
 * (vitest) and when running compiled JS from `lib/`. In both cases `__dirname`
 * + ../../src/skills lands at `functions/src/skills/`.
 */
export function getSkillsDir(): string {
  return path.resolve(__dirname, "..", "..", "src", "skills");
}

/**
 * Scan a directory for `<skill>/SKILL.md` files, parse them, and return the
 * registry. Throws if any single skill file is malformed — better to fail
 * deploy than silently drop a skill.
 */
export function loadSkillsFromDir(dir: string): SkillDefinition[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const skills: SkillDefinition[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;

    const raw = fs.readFileSync(skillPath, "utf8");
    let def: SkillDefinition;
    try {
      def = parseSkillFile(raw);
    } catch (err) {
      throw new Error(`Failed to parse ${skillPath}: ${(err as Error).message}`);
    }

    if (def.name !== entry.name) {
      throw new Error(`Skill ${skillPath}: directory name "${entry.name}" does not match frontmatter name "${def.name}"`);
    }
    if (seen.has(def.name)) {
      throw new Error(`Duplicate skill name "${def.name}" in ${dir}`);
    }
    seen.add(def.name);
    skills.push(def);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// Cached at first access — Cloud Functions module-scope caching means we read
// the disk once per cold start, never on the hot path.
let cachedRegistry: SkillDefinition[] | null = null;

export function getSkillRegistry(): SkillDefinition[] {
  if (cachedRegistry) return cachedRegistry;
  try {
    cachedRegistry = loadSkillsFromDir(getSkillsDir());
  } catch (err) {
    console.error("skills: failed to load registry, returning empty list", err);
    cachedRegistry = [];
  }
  return cachedRegistry;
}

/** Test-only — reset the cache so each test loads from disk fresh. */
export function _resetSkillRegistryCache(): void {
  cachedRegistry = null;
}

/**
 * Pick a skill out of the registry by name. Returns undefined if the skill
 * doesn't exist — callers should treat that as "no skill" rather than throwing.
 */
export function findSkill(name: string): SkillDefinition | undefined {
  return getSkillRegistry().find(s => s.name === name);
}

/**
 * Render the metadata block for the picker — name + description only, no body.
 * Used by skillPicker.ts to send the registry to gpt-4o-mini at minimal token
 * cost. The body is injected only after the picker chooses ONE skill.
 */
export function renderSkillMetadataForPicker(): string {
  const reg = getSkillRegistry();
  if (reg.length === 0) return "";
  return reg.map(s => `- ${s.name}: ${s.description}`).join("\n");
}

/**
 * Render a chosen skill's body as a system-prompt directive. Wrapped in
 * <skill:name> tags so Sonnet attends to it as a discrete instruction block
 * and we can ablation-test by stripping the wrapper.
 */
export function buildSkillDirective(skill: SkillDefinition): string {
  return [
    `<skill:${skill.name}>`,
    skill.body,
    `</skill:${skill.name}>`,
  ].join("\n");
}
