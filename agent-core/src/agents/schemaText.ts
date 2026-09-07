// Rendering a JSON Schema into text a 2B model can act on. Both the MCP client
// (agents/mcpTools.ts) and the family-tools subagent (agents/toolTools.ts)
// expose their callable operations as *text* rather than real bound tools —
// a dynamic tool set can't be added to a compiled deepagents graph mid-turn —
// so how legibly that text renders is what determines whether a small model
// fills the parameters correctly. See docs/DECISIONS.md → "Skills and MCP"
// (progressive disclosure: list -> describe -> call).

/** The loose shape both sources hand us — MCP `inputSchema` is `Record<string,
 *  unknown>` off the wire, family-tool schemas are the stricter `JsonSchema`. */
export interface LooseSchema {
  type?: string;
  properties?: Record<string, LooseSchema | undefined>;
  items?: LooseSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
}

function asSchema(v: unknown): LooseSchema {
  return v && typeof v === "object" ? (v as LooseSchema) : {};
}

/** One-line summary for a catalog listing — top-level params only, nested
 *  objects collapse to "(object)". Cheap; stays in the `list_*` output. */
export function oneLineParams(schema: unknown): string {
  const s = asSchema(schema);
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  const parts = Object.entries(props).map(([name, raw]) => {
    const p = asSchema(raw);
    const bits: string[] = [p.type ?? "any"];
    if (p.enum) bits.push(`one of ${p.enum.map((e) => JSON.stringify(e)).join("/")}`);
    if (required.has(name)) bits.push("required");
    const note = p.description ? ` — ${p.description}` : "";
    return `${name} (${bits.join(", ")})${note}`;
  });
  return parts.length ? parts.join("; ") : "no parameters";
}

/** Full, indented parameter tree — walks nested objects and arrays. Returned by
 *  `describe_*` so the model sees the exact shape right before calling. */
export function fullSchemaText(schema: unknown): string {
  const s = asSchema(schema);
  const props = s.properties ?? {};
  if (Object.keys(props).length === 0) return "This operation takes no parameters. Call it with an empty object {}.";
  const required = new Set(s.required ?? []);
  const lines: string[] = [];
  const walk = (name: string, raw: LooseSchema | undefined, depth: number, isRequired: boolean) => {
    const p = asSchema(raw);
    const pad = "  ".repeat(depth);
    const bits: string[] = [];
    if (p.type === "array" && p.items) {
      bits.push(`array of ${asSchema(p.items).type ?? "item"}`);
    } else {
      bits.push(p.type ?? "any");
    }
    if (p.enum) bits.push(`one of ${p.enum.map((e) => JSON.stringify(e)).join(" / ")}`);
    if (isRequired) bits.push("required");
    const note = p.description ? ` — ${p.description}` : "";
    lines.push(`${pad}- ${name} (${bits.join(", ")})${note}`);
    // Recurse into object properties, and into an array's object items.
    const nested = p.type === "array" ? asSchema(p.items) : p;
    if (nested.properties) {
      const req = new Set(nested.required ?? []);
      for (const [k, v] of Object.entries(nested.properties)) walk(k, v, depth + 1, req.has(k));
    }
  };
  for (const [k, v] of Object.entries(props)) walk(k, v, 0, required.has(k));
  return lines.join("\n");
}
