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
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="" />
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
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
        return (
          <label key={option.name} className="command-option" data-invalid={error ? '' : undefined}>
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
          </label>
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
