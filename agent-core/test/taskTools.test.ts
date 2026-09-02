import { describe, it, expect, beforeEach } from "vitest";
import { Store, type ScopedStore } from "../src/db.js";
import { makeTaskTools } from "../src/agents/taskTools.js";

// Direct unit coverage of the tools bound to the task-agent subagent. The
// search_tasks tool was added alongside document search (see docs/DECISIONS.md,
// "Document/task search") so the agent can find one task by keyword instead of
// listing every task into a small model's context.
describe("task tools", () => {
  let store: ScopedStore;
  let tools: ReturnType<typeof makeTaskTools>;

  beforeEach(() => {
    const raw = new Store(":memory:");
    store = raw.scoped(raw.createUser({ username: "u", displayName: "U", password: "sekret123" }).id);
    tools = makeTaskTools(store);
  });

  function find(name: string) {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  it("create_task then list_tasks round-trips", async () => {
    await find("create_task").invoke({ title: "Pay water bill" });
    const list = (await find("list_tasks").invoke({})) as string;
    expect(list).toContain("Pay water bill");
  });

  it("search_tasks finds a task by a word in its title and returns its id", async () => {
    const created = (await find("create_task").invoke({ title: "Renew car registration" })) as string;
    const id = created.match(/task ([0-9A-Z]{8})/)?.[1];
    expect(id).toBeTruthy();

    const result = (await find("search_tasks").invoke({ query: "registration" })) as string;
    expect(result).toContain("Renew car registration");
    expect(result).toContain(id!);
  });

  it("search_tasks filters by status", async () => {
    await find("create_task").invoke({ title: "Book dentist appointment" });
    const result = (await find("search_tasks").invoke({ query: "dentist", status: "done" })) as string;
    expect(result).toContain("No tasks matched");
  });

  it("search_tasks reports a clean miss", async () => {
    await find("create_task").invoke({ title: "Water the plants" });
    const result = (await find("search_tasks").invoke({ query: "spaceship" })) as string;
    expect(result).toContain("No tasks matched");
  });
});
