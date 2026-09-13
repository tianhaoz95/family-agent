import { describe, it, expect } from "vitest";
import { makeLocationTools } from "../src/agents/locationTool.js";

// Direct unit coverage of get_current_location — the closure-over-a-mutable-
// getter shape server.ts uses so a per-turn value can reach a tool bound
// once when the (cached, reused-across-turns) agent was built. See
// docs/DECISIONS.md → "Caller geolocation".
describe("get_current_location tool", () => {
  it("reports coordinates when a location is available", async () => {
    const [tool] = makeLocationTools(() => ({ latitude: 37.3688, longitude: -122.0363, accuracyMeters: 12 }));
    const out = (await tool.invoke({})) as string;
    expect(out).toContain("37.36880");
    expect(out).toContain("-122.03630");
    expect(out).toContain("accuracy ~12m");
  });

  it("says plainly when nothing is available, instead of making one up", async () => {
    const [tool] = makeLocationTools(() => undefined);
    const out = (await tool.invoke({})) as string;
    expect(out.toLowerCase()).toContain("no location is available");
  });

  it("notes staleness for an old cached fix but not a fresh one", async () => {
    const [freshTool] = makeLocationTools(() => ({ latitude: 1, longitude: 2, ageSeconds: 3 }));
    const fresh = (await freshTool.invoke({})) as string;
    expect(fresh).not.toContain("cached fix");

    const [staleTool] = makeLocationTools(() => ({ latitude: 1, longitude: 2, ageSeconds: 600 }));
    const stale = (await staleTool.invoke({})) as string;
    expect(stale).toContain("cached fix");
    expect(stale).toContain("10 min ago");
  });

  it("reads the getter fresh on every call, not just once at construction", async () => {
    let current: { latitude: number; longitude: number } | undefined;
    const [tool] = makeLocationTools(() => current);

    const before = (await tool.invoke({})) as string;
    expect(before.toLowerCase()).toContain("no location is available");

    current = { latitude: 10, longitude: 20 };
    const after = (await tool.invoke({})) as string;
    expect(after).toContain("10.00000");
  });
});
