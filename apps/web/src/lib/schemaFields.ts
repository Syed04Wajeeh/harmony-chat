/** One input of an auto-generated settings form. */
export type SchemaField =
  | (Base & { kind: 'boolean' })
  | (Base & { kind: 'number'; integer: boolean; min?: number; max?: number })
  | (Base & { kind: 'enum'; options: string[] })
  | (Base & { kind: 'string'; maxLength?: number });

interface Base {
  key: string;
  label: string;
  description?: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `allowMultipleChoice` to "Allow multiple choice". */
export function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The inputs for a JSON Schema object: booleans, numbers, enums and plain strings. Anything
 * else (nested objects, arrays) is skipped; a module that needs more ships its own panel.
 */
export function fieldsFromSchema(schema: Json | null): SchemaField[] {
  const properties = schema?.['properties'];
  if (!isObject(properties)) return [];
  const fields: SchemaField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    if (!isObject(raw)) continue;
    const base: Base = {
      key,
      label: typeof raw['title'] === 'string' ? raw['title'] : humanize(key),
      ...(typeof raw['description'] === 'string' && { description: raw['description'] }),
    };
    const options = raw['enum'];
    if (Array.isArray(options) && options.every((option) => typeof option === 'string')) {
      fields.push({ ...base, kind: 'enum', options });
    } else if (raw['type'] === 'boolean') {
      fields.push({ ...base, kind: 'boolean' });
    } else if (raw['type'] === 'number' || raw['type'] === 'integer') {
      const min = raw['minimum'];
      const max = raw['maximum'];
      fields.push({
        ...base,
        kind: 'number',
        integer: raw['type'] === 'integer',
        ...(typeof min === 'number' && { min }),
        ...(typeof max === 'number' && { max }),
      });
    } else if (raw['type'] === 'string') {
      const maxLength = raw['maxLength'];
      fields.push({
        ...base,
        kind: 'string',
        ...(typeof maxLength === 'number' && { maxLength }),
      });
    }
  }
  return fields;
}
