import type { JsonSchema } from "./toolMcp.js";

// A deliberately small JSON Schema validator — just the shapes a generated
// `operations` array actually produces: an object with typed properties,
// `required`, and `enum`. Not a spec-complete validator; anything it doesn't
// understand it lets through (the tool's own handler is the backstop).
//
// Its job is to stop the planner from calling an operation with obviously wrong
// arguments (missing required field, string where a number is wanted) before a
// request ever reaches the sandboxed tool.

export interface ValidationResult {
  ok: boolean;
  /** Coerced value (e.g. "3" -> 3 for a number field). */
  value: Record<string, unknown>;
  errors: string[];
}

function checkType(value: unknown, schema: JsonSchema, path: string, errors: string[]): unknown {
  const t = schema.type;
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    return value;
  }
  if (!t) return value;

  if (t === "string") {
    if (typeof value !== "string") errors.push(`${path} must be a string`);
    return value;
  }
  if (t === "number" || t === "integer") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      const n = Number(value);
      return t === "integer" && !Number.isInteger(n) ? (errors.push(`${path} must be a whole number`), value) : n;
    }
    errors.push(`${path} must be a number`);
    return value;
  }
  if (t === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    errors.push(`${path} must be true or false`);
    return value;
  }
  if (t === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return value;
    }
    if (schema.items) return value.map((v, i) => checkType(v, schema.items!, `${path}[${i}]`, errors));
    return value;
  }
  if (t === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return value;
    }
    return validateObject(value as Record<string, unknown>, schema, path, errors);
  }
  return value;
}

function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  errors: string[],
): Record<string, unknown> {
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = { ...value };
  for (const req of schema.required ?? []) {
    if (value[req] === undefined || value[req] === null || value[req] === "") {
      errors.push(`${path ? path + "." : ""}${req} is required`);
    }
  }
  for (const [key, sub] of Object.entries(props)) {
    if (value[key] === undefined) continue;
    out[key] = checkType(value[key], sub, `${path ? path + "." : ""}${key}`, errors);
  }
  return out;
}

export function validateInput(schema: JsonSchema | undefined, input: unknown): ValidationResult {
  const errors: string[] = [];
  const base: Record<string, unknown> =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    errors.push("input must be an object");
  }
  if (!schema || (schema.type && schema.type !== "object")) {
    return { ok: errors.length === 0, value: base, errors };
  }
  const value = validateObject(base, schema, "", errors);
  return { ok: errors.length === 0, value, errors };
}
