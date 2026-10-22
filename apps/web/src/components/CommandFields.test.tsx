import type { GuildCommand } from '@harmony/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommandFields } from './CommandFields.js';

const command: GuildCommand = {
  botId: '9',
  botName: 'Dice',
  name: 'roll',
  description: 'Roll a die',
  options: [
    { name: 'sides', description: 'Sides', type: 'integer', required: true },
    { name: 'secret', description: 'Hide it', type: 'boolean', required: false },
  ],
};

const setup = (errors: Record<string, string> = {}) => {
  const handlers = { onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn() };
  render(
    <CommandFields
      active={{ command, values: { sides: '20' }, errors }}
      members={[]}
      channels={[]}
      {...handlers}
    />,
  );
  return handlers;
};

describe('CommandFields', () => {
  it('shows the command and one field per option, marking required ones', () => {
    setup();
    expect(screen.getByText('/roll')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'sides' })).toHaveValue('20');
    expect(screen.getByRole('textbox', { name: 'sides' })).toBeRequired();
    expect(screen.getByRole('combobox', { name: 'secret' })).toBeInTheDocument();
  });

  it('reports edits, submits on Enter and cancels on Escape', async () => {
    const user = userEvent.setup();
    const { onChange, onSubmit, onCancel } = setup();
    await user.type(screen.getByRole('textbox', { name: 'sides' }), '5');
    expect(onChange).toHaveBeenCalledWith('sides', '205');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledOnce();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('announces validation errors next to the field', () => {
    setup({ sides: 'Enter a whole number' });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number');
    expect(screen.getByRole('textbox', { name: 'sides' })).toBeInvalid();
  });
});
