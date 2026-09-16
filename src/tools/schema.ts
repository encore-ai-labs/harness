/**
 * Tiny JSON-schema validator: enough for tool parameters (object/array/
 * string/number/integer/boolean, required, enum, additionalProperties).
 * Returns a list of human-readable problems the model can act on.
 */
export function validate(schema: any, value: unknown, path = "args"): string[] {
  const errs: string[] = [];
  const t = schema?.type;
  const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  if (t === "object") {
    if (typeOf(value) !== "object") return [`${path} must be an object`];
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? [])
      if (obj[r] === undefined) errs.push(`${path}.${r} is required`);
    for (const [k, v] of Object.entries(obj)) {
      const ps = schema.properties?.[k];
      if (!ps) {
        if (schema.additionalProperties === false)
          errs.push(`${path}.${k} is not an accepted parameter`);
        continue;
      }
      if (v === null) {
        const t = ps.type;
        const allowsNull = t === "null" || (Array.isArray(t) && t.includes("null"));
        if (!allowsNull) errs.push(`${path}.${k} must not be null`);
        continue;
      }
      if (v !== undefined) errs.push(...validate(ps, v, `${path}.${k}`));
    }
  } else if (t === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (schema.items)
      value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  } else if (t === "string") {
    if (typeof value !== "string") errs.push(`${path} must be a string`);
    else if (schema.enum && !schema.enum.includes(value))
      errs.push(`${path} must be one of ${schema.enum.join(", ")}`);
  } else if (t === "integer" || t === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) errs.push(`${path} must be a number`);
    else if (t === "integer" && !Number.isInteger(value)) errs.push(`${path} must be an integer`);
  } else if (t === "boolean") {
    if (typeof value !== "boolean") errs.push(`${path} must be a boolean`);
  }
  return errs;
}
