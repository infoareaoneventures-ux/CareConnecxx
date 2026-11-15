// Model slips in tool arguments, fixed from the tool's OWN declared schema before the handler runs (2026-11-15).
// Founders' text test: the model sent an emergency contact as [{...}] where one object was declared and the handler said
// "The contact needs a name" twice. The same slip can hit any tool, so the common ones are repaired in one place:
//   · an object declared, a one-item list holding an object sent  → the object
//   · a list declared, a single object sent                        → a list of one
//   · a string declared, a number or boolean sent                  → its text
//   · a number declared, a numeric string sent                     → the number
//   · a boolean declared, "true" / "false" sent                    → the boolean
// A property with no declared type (a union such as update_care_plan's `value`) is left to its handler. Nothing is
// invented: a value that does not fit is returned as it came, and the handler's own validation answers.

type Json = Record<string, unknown>;

interface PropSchema { type?: string | string[]; properties?: Record<string, PropSchema>; items?: PropSchema }
interface ToolSchema { properties?: Record<string, PropSchema> }

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function coerceOne(value: unknown, prop: PropSchema | undefined): unknown {
  const type = Array.isArray(prop?.type) ? undefined : prop?.type;
  if (!prop || !type) return value;
  if (type === "object") {
    const v = Array.isArray(value) && value.length === 1 && isObj(value[0]) ? value[0] : value;
    if (isObj(v) && prop.properties) {
      const out: Json = { ...v };
      for (const [k, sub] of Object.entries(prop.properties)) if (k in out) out[k] = coerceOne(out[k], sub);
      return out;
    }
    return v;
  }
  if (type === "array") {
    const list = Array.isArray(value) ? value : isObj(value) ? [value] : value;
    if (Array.isArray(list) && prop.items) return list.map((x) => coerceOne(x, prop.items));
    return list;
  }
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  if ((type === "number" || type === "integer") && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (type === "boolean" && typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return value;
}

export function coerceToolInput(input: Record<string, unknown>, schema: ToolSchema | undefined): Record<string, unknown> {
  if (!schema?.properties || !isObj(input)) return input;
  const out: Json = { ...input };
  for (const [k, prop] of Object.entries(schema.properties)) if (k in out) out[k] = coerceOne(out[k], prop);
  return out;
}
