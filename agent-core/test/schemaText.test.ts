import { describe, it, expect } from "vitest";
import { oneLineParams, fullSchemaText } from "../src/agents/schemaText.js";

describe("oneLineParams", () => {
  it("renders top-level params with type / enum / required", () => {
    const out = oneLineParams({
      type: "object",
      properties: {
        query: { type: "string", description: "what to search for" },
        limit: { type: "number" },
        kind: { type: "string", enum: ["bill", "receipt"] },
      },
      required: ["query"],
    });
    expect(out).toBe(
      'query (string, required) — what to search for; limit (number); kind (string, one of "bill"/"receipt")'
    );
  });

  it("says so when there are no parameters", () => {
    expect(oneLineParams({ type: "object", properties: {} })).toBe("no parameters");
    expect(oneLineParams(undefined)).toBe("no parameters");
    expect(oneLineParams("garbage")).toBe("no parameters");
  });
});

describe("fullSchemaText", () => {
  it("walks nested objects and arrays", () => {
    const out = fullSchemaText({
      type: "object",
      properties: {
        title: { type: "string", description: "event title" },
        when: {
          type: "object",
          description: "the time window",
          properties: {
            start: { type: "string", description: "ISO datetime" },
            end: { type: "string" },
          },
          required: ["start"],
        },
        attendees: {
          type: "array",
          items: { type: "object", properties: { email: { type: "string" }, optional: { type: "boolean" } } },
        },
      },
      required: ["title", "when"],
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("- title (string, required) — event title");
    expect(lines[1]).toBe("- when (object, required) — the time window");
    expect(lines[2]).toBe("  - start (string, required) — ISO datetime");
    expect(lines[3]).toBe("  - end (string)");
    expect(lines[4]).toBe("- attendees (array of object)");
    expect(lines[5]).toBe("  - email (string)");
    expect(lines[6]).toBe("  - optional (boolean)");
  });

  it("handles an empty schema", () => {
    expect(fullSchemaText({ type: "object", properties: {} })).toMatch(/no parameters.*empty object/i);
    expect(fullSchemaText(undefined)).toMatch(/no parameters/i);
  });
});
