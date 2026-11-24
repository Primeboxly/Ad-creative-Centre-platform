// Small JSON-schema checker for AI answers (the subset we use: object, array, string, number, integer, boolean,
// required, enum, minItems, maxItems, minLength, additionalProperties: false).
// The full schema (with limits) is checked here; the API gets a copy without the limits it may not support.

export function validate(schema, value, path = '$') {
  const errors = [];
  const t = schema.type;
  const typeOk = {
    object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: v => Array.isArray(v),
    string: v => typeof v === 'string',
    number: v => typeof v === 'number' && Number.isFinite(v),
    integer: v => Number.isInteger(v),
    boolean: v => typeof v === 'boolean',
    null: v => v === null,
  };
  const types = Array.isArray(t) ? t : [t];
  if (t && !types.some(x => typeOk[x]?.(value))) return [`${path}: expected ${types.join(' or ')}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && schema.minLength && value.trim().length < schema.minLength) errors.push(`${path}: too short`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items (got ${value.length})`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: at most ${schema.maxItems} items (got ${value.length})`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (typeOk.object(value) && schema.properties) {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: missing`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties[k]) errors.push(...validate(schema.properties[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: not allowed`);
    }
  }
  return errors;
}

// The schema sent to the API: same shape, without the limit keywords.
const LIMITS = new Set(['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']);
export function forApi(schema) {
  if (Array.isArray(schema)) return schema.map(forApi);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) if (!LIMITS.has(k)) out[k] = typeof v === 'object' ? forApi(v) : v;
  return out;
}

// The API cannot enforce list sizes, so the AI sometimes sends a longer list than asked (e.g. 15 items where 10 is the limit).
// Keep the first ones instead of refusing the whole answer. Changes `value` in place and returns it.
export function trimLists(schema, value) {
  if (!schema || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) value.length = schema.maxItems;
    if (schema.items) value.forEach(v => trimLists(schema.items, v));
  } else if (schema.properties) {
    for (const [k, v] of Object.entries(value)) if (schema.properties[k]) trimLists(schema.properties[k], v);
  }
  return value;
}
