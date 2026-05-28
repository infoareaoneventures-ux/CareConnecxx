import { describe, it, expect, beforeEach } from "vitest";
import fs   from "fs";
import os   from "os";
import path from "path";

import {
  parseSkillFile,
  loadSkillsFromDir,
  getSkillRegistry,
  _resetSkillRegistryCache,
  findSkill,
  renderSkillMetadataForPicker,
  buildSkillDirective,
} from "./skills";

const FM = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`;

describe("parseSkillFile", () => {
  it("parses a valid SKILL.md", () => {
    const def = parseSkillFile(FM("draft-care-update", "Draft an update.", "# Body\n\nDo the thing."));
    expect(def.name).toBe("draft-care-update");
    expect(def.description).toBe("Draft an update.");
    expect(def.body).toContain("# Body");
    expect(def.body).toContain("Do the thing.");
  });

  it("handles CRLF line endings (Windows-checked-in files)", () => {
    const raw = "---\r\nname: x-y\r\ndescription: \"d\"\r\n---\r\n\r\nbody\r\n";
    const def = parseSkillFile(raw);
    expect(def.name).toBe("x-y");
    expect(def.body).toBe("body");
  });

  it("parses unquoted description values", () => {
    const raw = "---\nname: foo\ndescription: some plain text\n---\n\nbody\n";
    const def = parseSkillFile(raw);
    expect(def.description).toBe("some plain text");
  });

  it("preserves escaped quotes inside the description", () => {
    const raw = "---\nname: foo\ndescription: \"trigger on \\\"hello\\\" replies\"\n---\n\nbody\n";
    const def = parseSkillFile(raw);
    expect(def.description).toBe("trigger on \"hello\" replies");
  });

  it("throws when frontmatter is missing entirely", () => {
    expect(() => parseSkillFile("# just a body\n")).toThrow(/must start with/i);
  });

  it("throws when frontmatter is not terminated", () => {
    expect(() => parseSkillFile("---\nname: x\ndescription: y\nbody here")).toThrow(/not terminated/i);
  });

  it("throws when name is missing", () => {
    expect(() => parseSkillFile("---\ndescription: x\n---\n\nbody\n")).toThrow(/missing required field: name/);
  });

  it("throws when description is missing", () => {
    expect(() => parseSkillFile("---\nname: foo\n---\n\nbody\n")).toThrow(/missing required field: description/);
  });

  it("throws when name violates hyphen-case", () => {
    expect(() => parseSkillFile(FM("Foo_Bar", "d", "body"))).toThrow(/hyphen-case/i);
    expect(() => parseSkillFile(FM("1foo", "d", "body"))).toThrow(/hyphen-case/i);
    expect(() => parseSkillFile(FM("foo bar", "d", "body"))).toThrow(/hyphen-case/i);
  });

  it("throws when name exceeds 64 chars", () => {
    const long = "a".repeat(65);
    expect(() => parseSkillFile(FM(long, "d", "body"))).toThrow(/exceeds 64/);
  });

  it("throws when description exceeds 1024 chars", () => {
    const long = "x".repeat(1025);
    expect(() => parseSkillFile(`---\nname: foo\ndescription: "${long}"\n---\n\nbody\n`)).toThrow(/exceeds 1024/);
  });

  it("throws when body is empty", () => {
    expect(() => parseSkillFile(FM("foo", "d", ""))).toThrow(/empty body/);
  });
});

describe("loadSkillsFromDir", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cara-skills-"));
  });

  it("returns [] for a non-existent directory", () => {
    expect(loadSkillsFromDir(path.join(tmp, "nope"))).toEqual([]);
  });

  it("loads skills sorted by name", () => {
    fs.mkdirSync(path.join(tmp, "zeta-skill"));
    fs.mkdirSync(path.join(tmp, "alpha-skill"));
    fs.writeFileSync(path.join(tmp, "zeta-skill",  "SKILL.md"), FM("zeta-skill",  "z",   "body z"));
    fs.writeFileSync(path.join(tmp, "alpha-skill", "SKILL.md"), FM("alpha-skill", "a",   "body a"));

    const out = loadSkillsFromDir(tmp);
    expect(out.map(s => s.name)).toEqual(["alpha-skill", "zeta-skill"]);
  });

  it("throws when a directory name does not match the skill name", () => {
    fs.mkdirSync(path.join(tmp, "wrong-dir"));
    fs.writeFileSync(path.join(tmp, "wrong-dir", "SKILL.md"), FM("right-name", "d", "body"));
    expect(() => loadSkillsFromDir(tmp)).toThrow(/does not match frontmatter name/);
  });

  it("loads multiple distinct skills without collision", () => {
    fs.mkdirSync(path.join(tmp, "foo"));
    fs.mkdirSync(path.join(tmp, "bar"));
    fs.writeFileSync(path.join(tmp, "foo", "SKILL.md"), FM("foo", "d", "b"));
    fs.writeFileSync(path.join(tmp, "bar", "SKILL.md"), FM("bar", "d", "b"));
    expect(loadSkillsFromDir(tmp).map(s => s.name)).toEqual(["bar", "foo"]);
  });

  it("ignores directories that lack a SKILL.md", () => {
    fs.mkdirSync(path.join(tmp, "real"));
    fs.mkdirSync(path.join(tmp, "empty-dir"));
    fs.writeFileSync(path.join(tmp, "real", "SKILL.md"), FM("real", "d", "body"));
    expect(loadSkillsFromDir(tmp).map(s => s.name)).toEqual(["real"]);
  });

  it("wraps parse errors with the file path so failures are debuggable", () => {
    fs.mkdirSync(path.join(tmp, "broken"));
    fs.writeFileSync(path.join(tmp, "broken", "SKILL.md"), "not a real skill file");
    expect(() => loadSkillsFromDir(tmp)).toThrow(/broken[\\/]SKILL\.md/);
  });
});

describe("getSkillRegistry (real catalog)", () => {
  beforeEach(() => _resetSkillRegistryCache());

  it("loads the three starter skills from the project catalog", () => {
    const reg = getSkillRegistry();
    const names = reg.map(s => s.name);
    expect(names).toContain("draft-care-update");
    expect(names).toContain("explain-bill");
    expect(names).toContain("triage-journal-flag");
  });

  it("caches the registry across calls", () => {
    const a = getSkillRegistry();
    const b = getSkillRegistry();
    expect(a).toBe(b); // same reference
  });

  it("findSkill returns the matching definition or undefined", () => {
    expect(findSkill("draft-care-update")?.name).toBe("draft-care-update");
    expect(findSkill("does-not-exist")).toBeUndefined();
  });

  it("renderSkillMetadataForPicker emits one line per skill (no body)", () => {
    const md = renderSkillMetadataForPicker();
    expect(md).toContain("draft-care-update");
    expect(md).toContain("explain-bill");
    expect(md).toContain("triage-journal-flag");
    // Bodies are not in the picker view.
    expect(md).not.toContain("Drafting rules");
    expect(md).not.toContain("Triage rules");
  });

  it("buildSkillDirective wraps the body in <skill:name> tags", () => {
    const skill = findSkill("draft-care-update")!;
    const out   = buildSkillDirective(skill);
    expect(out.startsWith("<skill:draft-care-update>")).toBe(true);
    expect(out.endsWith("</skill:draft-care-update>")).toBe(true);
    expect(out).toContain(skill.body);
  });
});
