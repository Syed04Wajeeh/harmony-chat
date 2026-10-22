import { useId, useState } from 'react';
import type { SchemaField } from '../../lib/schemaFields.js';

interface Props {
  fields: readonly SchemaField[];
  values: Record<string, unknown>;
  disabled?: boolean;
  /** Called with just the changed setting. Switches and choices commit at once, typed values on blur. */
  onChange: (patch: Record<string, unknown>) => void;
}

function TypedInput({
  field,
  value,
  disabled,
  onCommit,
}: {
  field: Extract<SchemaField, { kind: 'number' | 'string' }>;
  value: unknown;
  disabled: boolean;
  onCommit: (value: string | number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown =
    draft ?? (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

  function commit() {
    if (draft === null) return;
    setDraft(null);
    if (field.kind === 'string') return draft === value ? undefined : onCommit(draft);
    const parsed = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
  }

  return (
    <label className="field" htmlFor={id}>
      <span>{field.label}</span>
      <input
        id={id}
        value={shown}
        disabled={disabled}
        inputMode={field.kind === 'number' ? 'numeric' : undefined}
        {...(field.kind === 'string' && field.maxLength && { maxLength: field.maxLength })}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && commit()}
      />
      {field.description && <small className="field-hint">{field.description}</small>}
    </label>
  );
}

/** A settings form generated from a module's JSON Schema. */
export function SchemaForm({ fields, values, disabled = false, onChange }: Props) {
  return (
    <div className="schema-form">
      {fields.map((field) => {
        const value = values[field.key];
        if (field.kind === 'boolean') {
          return (
            <label key={field.key} className="switch-row">
              <span>
                <strong>{field.label}</strong>
                {field.description && <small>{field.description}</small>}
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={value === true}
                disabled={disabled}
                onChange={(event) => onChange({ [field.key]: event.target.checked })}
              />
            </label>
          );
        }
        if (field.kind === 'enum') {
          return (
            <label key={field.key} className="field">
              <span>{field.label}</span>
              <select
                value={typeof value === 'string' ? value : ''}
                disabled={disabled}
                onChange={(event) => onChange({ [field.key]: event.target.value })}
              >
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              {field.description && <small className="field-hint">{field.description}</small>}
            </label>
          );
        }
        return (
          <TypedInput
            key={field.key}
            field={field}
            value={value}
            disabled={disabled}
            onCommit={(next) => onChange({ [field.key]: next })}
          />
        );
      })}
    </div>
  );
}
