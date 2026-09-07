import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config, skillsDir } from "../config.js";

// A "skill" is a folder under <dataDir>/skills/<name>/ containing a SKILL.md
// (YAML-ish front-matter + a markdown body of instructions) and, optionally, a
// scripts/ directory. The planner is told only each skill's name + one-line
// description; it calls use_skill(name) to pull the full body into context for
// the rest of the turn. This is progressive disclosure — the same reason the
// subagent prompts aren't all concatenated onto the planner prompt.
//
// Skills are just text (+ sandboxed scripts), so this carries no new security
// surface and is on by default. See docs/DECISIONS.md → "Skills and MCP".

export interface SkillMeta {
  /** Folder name — the id used everywhere. Lowercase, kebab. */
  name: string;
  /** One line shown to the planner in list_skills. */
  description: string;
  /** Optional extra hint on WHEN to reach for this skill. */
  whenToUse?: string;
  enabled: boolean;
  /** Script file names in scripts/ (bare names), if any. */
  scripts: string[];
  updatedAt: string;
}

export interface Skill extends SkillMeta {
  /** The full markdown body (everything after the front-matter). */
  body: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Split "---\n<frontmatter>\n---\n<body>" into its parts. Front-matter is a
 *  forgiving `key: value` list (no nested YAML) — enough for name/description/
 *  when_to_use/enabled. A file with no front-matter is all body. */
export function parseSkillMarkdown(md: string): { fm: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md.replace(/^﻿/, ""));
  if (!m) return { fm: {}, body: md.trim() };
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fm[kv[1].toLowerCase().replace(/-/g, "_")] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body: m[2].trim() };
}

function skillDir(name: string): string {
  return join(skillsDir(), name);
}

function scriptNames(name: string): string[] {
  const dir = join(skillDir(name), "scripts");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => !f.startsWith(".") && statSync(join(dir, f)).isFile())
      .sort();
  } catch {
    return [];
  }
}

function readSkill(name: string): Skill | null {
  const file = join(skillDir(name), "SKILL.md");
  if (!existsSync(file)) return null;
  let md: string;
  try {
    md = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = parseSkillMarkdown(md);
  let updatedAt = new Date().toISOString();
  try {
    updatedAt = statSync(file).mtime.toISOString();
  } catch {
    /* keep default */
  }
  return {
    name,
    description: fm.description || body.split("\n")[0]?.slice(0, 140) || name,
    whenToUse: fm.when_to_use || fm.whentouse || undefined,
    enabled: fm.enabled ? !/^(false|no|0|off)$/i.test(fm.enabled) : true,
    scripts: scriptNames(name),
    updatedAt,
    body,
  };
}

/** Every skill folder that has a readable SKILL.md, name-sorted. */
export function listSkills(): Skill[] {
  const root = skillsDir();
  if (!existsSync(root)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue;
    const s = readSkill(entry.name);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): Skill | null {
  return isValidSkillName(name) ? readSkill(name) : null;
}

/** Create or overwrite a skill's SKILL.md. `markdown` may already carry
 *  front-matter; if it doesn't, one is synthesised from name/description. */
export function saveSkill(input: {
  name: string;
  description?: string;
  whenToUse?: string;
  enabled?: boolean;
  markdown: string;
}): Skill {
  if (!isValidSkillName(input.name)) {
    throw new Error(`"${input.name}" is not a valid skill name (lowercase letters, digits, hyphens).`);
  }
  const dir = skillDir(input.name);
  mkdirSync(dir, { recursive: true });

  const parsed = parseSkillMarkdown(input.markdown);
  const description = input.description ?? parsed.fm.description ?? parsed.body.split("\n")[0]?.slice(0, 140) ?? input.name;
  const whenToUse = input.whenToUse ?? parsed.fm.when_to_use;
  const enabled = input.enabled ?? (parsed.fm.enabled ? !/^(false|no|0|off)$/i.test(parsed.fm.enabled) : true);

  const fmLines = [
    `name: ${input.name}`,
    `description: ${sanitize(description)}`,
    ...(whenToUse ? [`when_to_use: ${sanitize(whenToUse)}`] : []),
    `enabled: ${enabled}`,
  ];
  const file = `---\n${fmLines.join("\n")}\n---\n\n${parsed.body}\n`;
  writeFileSync(join(dir, "SKILL.md"), file);
  return readSkill(input.name)!;
}

export function setSkillEnabled(name: string, enabled: boolean): Skill | null {
  const s = getSkill(name);
  if (!s) return null;
  return saveSkill({ name, description: s.description, whenToUse: s.whenToUse, enabled, markdown: s.body });
}

export function deleteSkill(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const dir = skillDir(name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Absolute path of a skill script, verified to exist. Used by the sandboxed
 *  runner. Rejects any name that isn't a plain file in scripts/. */
export function skillScriptPath(name: string, script: string): string {
  if (!isValidSkillName(name)) throw new Error("unknown skill");
  const clean = script.trim();
  if (!clean || clean.includes("/") || clean.includes("..") || clean.startsWith(".")) {
    throw new Error(`"${script}" is not a valid script name.`);
  }
  const p = join(skillDir(name), "scripts", clean);
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`"${script}" is not a script of the "${name}" skill.`);
  return p;
}

/** The dir a skill's scripts run against (read-only-mounted in the sandbox). */
export function skillRootPath(name: string): string {
  return skillDir(name);
}

export function skillsAvailable(): boolean {
  return config.skillsEnabled;
}

function sanitize(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
}
