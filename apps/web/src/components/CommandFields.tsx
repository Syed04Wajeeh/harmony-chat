import type { ChannelSummary, CommandOption, GuildCommand, User } from '@harmony/shared';
import { useId, type FormEvent, type KeyboardEvent } from 'react';
import { FORM_ERROR } from '../lib/commands.js';
import { CloseIcon } from './Icons.js';

export interface ActiveCommand {
  command: GuildCommand;
  values: Record<string, string>;
  errors: Record<string, string>;
}

interface Props {
  active: ActiveCommand;
  members: readonly User[];
  channels: readonly ChannelSummary[];
  onChange: (name: string, value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** true / false / unset as two chips; pressing the chosen one again clears it. */
function TriState({
  name,
  description,
  required,
  invalid,
  describedBy,
  autoFocus,
  value,
  onChange,
}: {
  name: string;
  description: string;
  required: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  autoFocus: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <span
      className="command-toggle"
      role="group"
      aria-label={name}
      aria-required={required}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      title={description}
    >
      {(['true', 'false'] as const).map((choice, index) => (
        <button
          key={choice}
          type="button"
          className="command-toggle-chip"
          aria-pressed={value === choice}
          autoFocus={autoFocus && index === 0}
          data-enter-submits=""
          onClick={() => onChange(value === choice ? '' : choice)}
        >
          {choice}
        </button>
      ))}
    </span>
  );
}

function OptionInput({
  option,
  value,
  invalid,
  describedBy,
  autoFocus,
  members,
  channels,
  onChange,
}: {
  option: CommandOption;
  value: string;
  invalid: boolean;
  describedBy: string | undefined;
  autoFocus: boolean;
  members: readonly User[];
  channels: readonly ChannelSummary[];
  onChange: (value: string) => void;
}) {
  const common = {
    'aria-label': option.name,
    'aria-required': option.required,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    title: option.description,
    autoFocus,
    value,
  };
  switch (option.type) {
    case 'boolean':
      return (
        <TriState
          name={option.name}
          description={option.description}
          required={option.required}
          invalid={invalid}
          describedBy={describedBy}
          autoFocus={autoFocus}
          value={value}
          onChange={onChange}
        />
      );
    case 'user':
      return (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="" />
          {members.map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName}
            </option>
          ))}
        </select>
      );
    case 'channel':
      return (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="" />
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              #{channel.name}
            </option>
          ))}
        </select>
      );
    case 'integer':
      return (
        <input
          {...common}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={option.description}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'string':
      return (
        <input
          {...common}
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          placeholder={option.description}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/** The command chip and its option fields, shown in place of the message box. */
export function CommandFields({ active, members, channels, onChange, onSubmit, onCancel }: Props) {
  const { command, values, errors } = active;
  const id = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (
      event.key === 'Enter' &&
      event.target instanceof HTMLElement &&
      event.target.hasAttribute('data-enter-submits')
    ) {
      // Space toggles a chip; Enter runs the command like it does from a text field.
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <form className="command-fields" onSubmit={submit} onKeyDown={onKeyDown} noValidate>
      <div className="command-chip">
        <span>/{command.name}</span>
        <button
          type="button"
          className="command-cancel"
          aria-label={`Cancel /${command.name}`}
          onClick={onCancel}
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>
      {command.options.map((option, index) => {
        const error = errors[option.name];
        const errorId = `${id}-${option.name}`;
        // A label would forward clicks on its text to the first chip.
        const Field = option.type === 'boolean' ? 'div' : 'label';
        return (
          <Field
            key={option.name}
            className="command-option"
            data-type={option.type}
            data-invalid={error ? '' : undefined}
          >
            <span className="command-option-name">
              {option.name}
              {option.required && <abbr title="required">*</abbr>}
            </span>
            <OptionInput
              option={option}
              value={values[option.name] ?? ''}
              invalid={Boolean(error)}
              describedBy={error ? errorId : undefined}
              autoFocus={index === 0}
              members={members}
              channels={channels}
              onChange={(value) => onChange(option.name, value)}
            />
            {error && (
              <span id={errorId} className="command-error" role="alert">
                {error}
              </span>
            )}
          </Field>
        );
      })}
      {errors[FORM_ERROR] && (
        <span className="command-error" role="alert">
          {errors[FORM_ERROR]}
        </span>
      )}
      {command.options.length === 0 ? (
        <button type="submit" className="button button-primary command-run" autoFocus>
          Run
        </button>
      ) : (
        <button type="submit" hidden />
      )}
    </form>
  );
}
