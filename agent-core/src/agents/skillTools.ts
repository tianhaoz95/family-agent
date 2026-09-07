import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listSkills, getSkill } from "../skills/skills.js";
import { runSkillScript, skillScriptsRunnable } from "../skills/runScript.js";

// The planner's skill tools. `list_skills` is cheap (names + one-liners) and
// safe to leave in the prompt's tool list; `use_skill` loads the full
// instructions for one skill into the turn — progressive disclosure, so a 2B
// model isn't carrying every skill's body at once.

export interface SkillToolDeps {
  logActivity: (actor: string, action: string, detail: string) => void;
}

export function makeSkillTools(deps: SkillToolDeps) {
  const listSkillsTool = tool(
    async () => {
      const skills = listSkills().filter((s) => s.enabled);
      if (skills.length === 0) return "The family hasn't added any skills yet.";
      return skills
        .map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (use it when: ${s.whenToUse})` : ""}`)
        .join("\n");
    },
    {
      name: "list_skills",
      description:
        "List the family's skills — named playbooks with step-by-step instructions the family has taught you. Check this whenever a request might match one; then call use_skill to load the full instructions.",
      schema: z.object({}),
    }
  );

  const useSkillTool = tool(
    async ({ name }) => {
      const skill = getSkill(name);
      if (!skill || !skill.enabled) {
        const names = listSkills().filter((s) => s.enabled).map((s) => s.name);
        return names.length
          ? `No skill called "${name}". Available: ${names.join(", ")}.`
          : `No skill called "${name}", and the family has no skills yet.`;
      }
      deps.logActivity("skills", "skill.used", `Used the "${skill.name}" skill`);
      const scriptLine = skill.scripts.length
        ? `\n\nThis skill ships helper scripts: ${skill.scripts.join(", ")}. ` +
          `Run one with run_skill_script (sandboxed, no network).`
        : "";
      return (
        `Instructions for the "${skill.name}" skill — follow these for the rest of this task:\n\n` +
        `${skill.body}${scriptLine}`
      );
    },
    {
      name: "use_skill",
      description:
        "Load the full instructions for one skill (by its exact name from list_skills) and follow them for the rest of the task.",
      schema: z.object({ name: z.string().min(1).describe("The skill's name, e.g. 'weekly-meal-plan'") }),
    }
  );

  const runScriptTool = tool(
    async ({ skill, script, args }) => {
      const gate = skillScriptsRunnable();
      if (!gate.ok) return `Skill scripts can't run on this server (${gate.reason}).`;
      const out = await runSkillScript(skill, script, args ?? []);
      if (!out.ran) return `Could not run "${script}": ${out.reason}`;
      deps.logActivity("skills", "skill.script", `Ran ${skill}/${script}`);
      const parts = [`exit code: ${out.timedOut ? "timed out" : out.code}`];
      if (out.stdout.trim()) parts.push(`stdout:\n${out.stdout.trim()}`);
      if (out.stderr.trim()) parts.push(`stderr:\n${out.stderr.trim()}`);
      return parts.join("\n");
    },
    {
      name: "run_skill_script",
      description:
        "Run one helper script that belongs to a skill (from use_skill's 'ships helper scripts' line). `args` is a plain string list. Runs sandboxed with no network. Only call this after use_skill told you the script exists.",
      schema: z.object({
        skill: z.string().min(1),
        script: z.string().min(1),
        args: z.array(z.string()).default([]),
      }),
    }
  );

  return [listSkillsTool, useSkillTool, runScriptTool];
}
