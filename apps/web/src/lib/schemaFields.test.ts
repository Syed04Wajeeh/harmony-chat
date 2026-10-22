import { describe, expect, it } from 'vitest';
import { fieldsFromSchema, humanize } from './schemaFields.js';

describe('humanize', () => {
  it('turns keys into labels', () => {
    expect(humanize('allowMultipleChoice')).toBe('Allow multiple choice');
    expect(humanize('max_items')).toBe('Max items');
  });
});

describe('fieldsFromSchema', () => {
  it('builds a field per supported type from a zod-generated schema', () => {
    const schema = {
      type: 'object',
      properties: {
        on: { type: 'boolean', default: true },
        limit: { type: 'integer', minimum: 1, maximum: 5 },
        ratio: { type: 'number' },
        mode: { type: 'string', enum: ['quiet', 'loud'] },
        note: { type: 'string', maxLength: 40 },
        nested: { type: 'object', properties: {} },
      },
    };
    expect(fieldsFromSchema(schema)).toEqual([
      { key: 'on', label: 'On', kind: 'boolean' },
      { key: 'limit', label: 'Limit', kind: 'number', integer: true, min: 1, max: 5 },
      { key: 'ratio', label: 'Ratio', kind: 'number', integer: false },
      { key: 'mode', label: 'Mode', kind: 'enum', options: ['quiet', 'loud'] },
      { key: 'note', label: 'Note', kind: 'string', maxLength: 40 },
    ]);
  });

  it('uses the title and description a module gave its setting', () => {
    const schema = {
      properties: {
        allowMultipleChoice: { type: 'boolean', title: 'Allow it', description: 'Why' },
      },
    };
    expect(fieldsFromSchema(schema)).toEqual([
      { key: 'allowMultipleChoice', label: 'Allow it', description: 'Why', kind: 'boolean' },
    ]);
  });

  it('has no fields without a schema', () => {
    expect(fieldsFromSchema(null)).toEqual([]);
    expect(fieldsFromSchema({ type: 'object' })).toEqual([]);
  });
});
