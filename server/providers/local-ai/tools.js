/**
 * Realtime tool list → chat tools for local models.
 *
 * Shared by the Local AI voice proxy and the voice benchmark
 * (scripts/voice-bench/toolFormats.mjs re-exports these), so the benchmark
 * measures exactly the tool payload a local voice session sends.
 */

export const PERMISSIVE_SCALAR = Object.freeze(['string', 'number', 'boolean']);

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Normalize a JSON schema for OpenAI-compatible local servers.
 *
 * Only one change: a property schema with no `type` (and no enum / anyOf /
 * oneOf / $ref / const that would imply one) gets a permissive scalar union.
 * `analyst_query.filters[].value` is `{}` in production — valid JSON Schema,
 * but chat templates that print `type` for every property (Gemma's among
 * them) crash on it.
 */
export function normalizeSchemaForChat(schema) {
  const out = clone(schema);
  const visit = (node, isRoot) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const implied = [
      'type',
      'enum',
      'anyOf',
      'oneOf',
      'allOf',
      '$ref',
      'const',
    ].some((k) => k in node);
    if (!isRoot && !implied) node.type = [...PERMISSIVE_SCALAR];
    if (node.properties)
      for (const sub of Object.values(node.properties)) visit(sub, false);
    if (node.items) visit(node.items, false);
    for (const key of ['anyOf', 'oneOf', 'allOf'])
      if (Array.isArray(node[key])) node[key].forEach((s) => visit(s, false));
  };
  visit(out, true);
  return out;
}

/** Realtime tools → Chat Completions tools (`{type:'function', function:{...}}`). */
export function toChatTools(realtimeTools, { normalize = true } = {}) {
  return realtimeTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalize
        ? normalizeSchemaForChat(tool.parameters)
        : clone(tool.parameters),
    },
  }));
}
