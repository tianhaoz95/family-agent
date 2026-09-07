import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config, skillsDir } from "../src/config.js";
import {
  parseSkillMarkdown,
  isValidSkillName,
  saveSkill,
  listSkills,
  getSkill,
  setSkillEnabled,
  deleteSkill,
  skillScriptPath,
} from "../src/skills/skills.js";
import { makeSkillTools } from "../src/agents/skillTools.js";
import { runSkillScript } from "../src/skills/runScript.js";
import { sandboxAvailable } from "../src/shell/sandbox.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

const sandbox = sandboxAvailable().ok;

let realDataDir: string;

beforeEach(() => {
  realDataDir = config.dataDir;
  config.dataDir = mkdtempSync(join(tmpdir(), "fa-skills-"));
});
afterEach(() => {
  rmSync(config.dataDir, { recursive: true, force: true });
  config.dataDir = realDataDir;
});

describe("parseSkillMarkdown", () => {
  it("splits front-matter from body and normalises keys", () => {
    const { fm, body } = parseSkillMarkdown(
      `---\nname: meal-plan\ndescription: "Plan the week's meals"\nwhen-to-use: sunday evenings\nenabled: false\n---\n\n# Meal plan\n\nDo the thing.`
    );
    expect(fm.name).toBe("meal-plan");
    expect(fm.description).toBe("Plan the week's meals");
    expect(fm.when_to_use).toBe("sunday evenings");
    expect(fm.enabled).toBe("false");
    expect(body).toBe("# Meal plan\n\nDo the thing.");
  });

  it("treats a file with no front-matter as all body", () => {
    const { fm, body } = parseSkillMarkdown("# Just instructions\n\nStep one.");
    expect(fm).toEqual({});
    expect(body).toBe("# Just instructions\n\nStep one.");
  });
});

describe("isValidSkillName", () => {
  it("accepts kebab, rejects junk", () => {
    expect(isValidSkillName("weekly-meal-plan")).toBe(true);
    expect(isValidSkillName("a")).toBe(true);
    for (const bad of ["Meal Plan", "meal_plan", "-lead", "../x", "a".repeat(50), ""]) {
      expect(isValidSkillName(bad), bad).toBe(false);
    }
  });
});

describe("saveSkill / listSkills / getSkill", () => {
  it("synthesises front-matter when the markdown has none", () => {
    const s = saveSkill({ name: "groceries", description: "Build a grocery list", markdown: "# Groceries\n\nAsk what's needed." });
    expect(s.name).toBe("groceries");
    expect(s.description).toBe("Build a grocery list");
    expect(s.enabled).toBe(true);
    expect(s.body).toBe("# Groceries\n\nAsk what's needed.");
    // round-trips through disk
    expect(getSkill("groceries")?.body).toBe("# Groceries\n\nAsk what's needed.");
    expect(listSkills().map((x) => x.name)).toEqual(["groceries"]);
  });

  it("keeps front-matter the markdown already carries", () => {
    const s = saveSkill({
      name: "bills",
      markdown: `---\nname: bills\ndescription: Chase overdue bills\nenabled: true\n---\n\nList tasks tagged bill.`,
    });
    expect(s.description).toBe("Chase overdue bills");
    expect(s.body).toBe("List tasks tagged bill.");
  });

  it("rejects an invalid name", () => {
    expect(() => saveSkill({ name: "Bad Name", markdown: "x" })).toThrow();
  });

  it("lists skills name-sorted and ignores non-skill folders", () => {
    saveSkill({ name: "zebra", description: "z", markdown: "z" });
    saveSkill({ name: "alpha", description: "a", markdown: "a" });
    mkdirSync(join(skillsDir(), "not a skill"), { recursive: true });
    mkdirSync(join(skillsDir(), "emptydir"), { recursive: true });
    expect(listSkills().map((s) => s.name)).toEqual(["alpha", "zebra"]);
  });
});

describe("setSkillEnabled / deleteSkill", () => {
  it("toggles enabled without losing the body", () => {
    saveSkill({ name: "s", description: "d", markdown: "the body" });
    const off = setSkillEnabled("s", false);
    expect(off?.enabled).toBe(false);
    expect(off?.body).toBe("the body");
    expect(getSkill("s")?.enabled).toBe(false);
  });
  it("returns null toggling a missing skill", () => {
    expect(setSkillEnabled("nope", true)).toBeNull();
  });
  it("deletes and reports whether anything was removed", () => {
    saveSkill({ name: "s", description: "d", markdown: "b" });
    expect(deleteSkill("s")).toBe(true);
    expect(deleteSkill("s")).toBe(false);
    expect(getSkill("s")).toBeNull();
  });
});

describe("skillScriptPath", () => {
  beforeEach(() => {
    saveSkill({ name: "hasscript", description: "d", markdown: "b" });
    mkdirSync(join(skillsDir(), "hasscript", "scripts"), { recursive: true });
    writeFileSync(join(skillsDir(), "hasscript", "scripts", "go.py"), "print(1)");
  });
  it("resolves a real script", () => {
    expect(skillScriptPath("hasscript", "go.py")).toBe(join(skillsDir(), "hasscript", "scripts", "go.py"));
  });
  it("rejects traversal, nesting, hidden, and unknown names", () => {
    for (const bad of ["../SKILL.md", "sub/go.py", ".hidden", "missing.py"]) {
      expect(() => skillScriptPath("hasscript", bad), bad).toThrow();
    }
  });
});

describe("makeSkillTools", () => {
  const logs: string[] = [];
  const deps = { logActivity: (_a: string, action: string) => void logs.push(action) };

  beforeEach(() => {
    logs.length = 0;
  });

  it("list_skills shows only enabled skills", async () => {
    saveSkill({ name: "on-skill", description: "visible", markdown: "b" });
    saveSkill({ name: "off-skill", description: "hidden", markdown: "b", enabled: false });
    const [list] = makeSkillTools(deps);
    const out = (await list.invoke({})) as string;
    expect(out).toContain("on-skill");
    expect(out).not.toContain("off-skill");
  });

  it("use_skill returns the body and logs the use", async () => {
    saveSkill({ name: "recipe", description: "d", markdown: "# Steps\n\n1. cook" });
    const [, use] = makeSkillTools(deps);
    const out = (await use.invoke({ name: "recipe" })) as string;
    expect(out).toContain("1. cook");
    expect(logs).toContain("skill.used");
  });

  it("use_skill on a missing name lists what's available", async () => {
    saveSkill({ name: "real", description: "d", markdown: "b" });
    const [, use] = makeSkillTools(deps);
    const out = (await use.invoke({ name: "ghost" })) as string;
    expect(out).toMatch(/No skill called "ghost"/);
    expect(out).toContain("real");
  });
});

describe.skipIf(!sandbox)("runSkillScript (sandboxed)", () => {
  it("runs a shell script with the skill folder mounted read-only at /skill", async () => {
    saveSkill({ name: "scripted", description: "d", markdown: "b" });
    mkdirSync(join(skillsDir(), "scripted", "scripts"), { recursive: true });
    writeFileSync(
      join(skillsDir(), "scripted", "scripts", "hello.sh"),
      "echo \"hi $1\"; cat /skill/SKILL.md | head -1"
    );
    const out = await runSkillScript("scripted", "hello.sh", ["there"]);
    expect(out.ran).toBe(true);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("hi there");
    expect(out.stdout).toContain("---"); // front-matter of the mounted SKILL.md
  });

  it("cannot see the host filesystem outside /skill and /work", async () => {
    saveSkill({ name: "isolation", description: "d", markdown: "b" });
    mkdirSync(join(skillsDir(), "isolation", "scripts"), { recursive: true });
    writeFileSync(
      join(skillsDir(), "isolation", "scripts", "peek.sh"),
      "ls /home 2>/dev/null && echo HOME_VISIBLE || echo HOME_HIDDEN; ls /root 2>/dev/null && echo ROOT_VISIBLE || echo ROOT_HIDDEN"
    );
    const out = await runSkillScript("isolation", "peek.sh");
    expect(out.stdout).toContain("HOME_HIDDEN");
    expect(out.stdout).toContain("ROOT_HIDDEN");
  });

  it("refuses an unsupported extension", async () => {
    saveSkill({ name: "badext", description: "d", markdown: "b" });
    mkdirSync(join(skillsDir(), "badext", "scripts"), { recursive: true });
    writeFileSync(join(skillsDir(), "badext", "scripts", "x.rb"), "puts 1");
    const out = await runSkillScript("badext", "x.rb");
    expect(out.ran).toBe(false);
    expect(out.reason).toMatch(/unsupported extension/);
  });
});

describe("skills routes", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  let asAdmin: ReturnType<typeof authInject>;
  let asMember: ReturnType<typeof authInject>;

  beforeEach(() => {
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
    asAdmin = authInject(app, admin.token);
    asMember = authInject(app, member.token);
  });
  afterEach(async () => {
    await app.close();
  });

  it("GET /skills lists for any user; POST/PATCH/DELETE are admin-only", async () => {
    const create = await asAdmin({
      method: "POST",
      url: "/skills",
      payload: { name: "trip-pack", description: "Packing list for trips", markdown: "# Pack\n\n- socks" },
    });
    expect(create.statusCode).toBe(201);

    const list = await asMember("/skills");
    expect(list.statusCode).toBe(200);
    expect(list.json().skills.map((s: { name: string }) => s.name)).toEqual(["trip-pack"]);

    const memberWrite = await asMember({
      method: "POST",
      url: "/skills",
      payload: { name: "sneaky", description: "x", markdown: "y" },
    });
    expect(memberWrite.statusCode).toBe(403);

    const toggle = await asAdmin({ method: "PATCH", url: "/skills/trip-pack", payload: { enabled: false } });
    expect(toggle.statusCode).toBe(200);
    expect(toggle.json().skill.enabled).toBe(false);

    const del = await asMember({ method: "DELETE", url: "/skills/trip-pack" });
    expect(del.statusCode).toBe(403);
    expect((await asAdmin({ method: "DELETE", url: "/skills/trip-pack" })).statusCode).toBe(200);
    expect((await asAdmin("/skills")).json().skills).toEqual([]);
  });

  it("GET /skills/:name 404s for a missing skill", async () => {
    expect((await asAdmin("/skills/nope")).statusCode).toBe(404);
  });

  it("rejects a bad skill name with 400", async () => {
    const res = await asAdmin({
      method: "POST",
      url: "/skills",
      payload: { name: "Bad Name", description: "x", markdown: "y" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("routes 404 when skills are disabled", async () => {
    const prev = config.skillsEnabled;
    config.skillsEnabled = false;
    try {
      expect((await asAdmin("/skills")).statusCode).toBe(404);
    } finally {
      config.skillsEnabled = prev;
    }
  });

  it("/health reports the skills capability", async () => {
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(["full", "docs-only"]).toContain(h.skills);
    const prev = config.skillsEnabled;
    config.skillsEnabled = false;
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json().skills).toBe("off");
    } finally {
      config.skillsEnabled = prev;
    }
  });
});
