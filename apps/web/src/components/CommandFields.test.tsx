import type { GuildCommand } from '@harmony/shared';
import { render, screen, within } from '@testing-library/react';
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

const setup = (errors: Record<string, string> = {}, values: Record<string, string> = {}) => {
  const handlers = { onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn() };
  render(
    <CommandFields
      active={{ command, values: { sides: '20', ...values }, errors }}
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
    expect(screen.getByRole('group', { name: 'secret' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
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

  it('sets a boolean with chips, clears it by pressing the chosen one again', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    const group = screen.getByRole('group', { name: 'secret' });
    expect(within(group).getByRole('button', { name: 'true' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await user.click(within(group).getByRole('button', { name: 'false' }));
    expect(onChange).toHaveBeenLastCalledWith('secret', 'false');
  });

  it('shows the current boolean value and unsets it on a second press', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({}, { secret: 'true' });
    const chip = screen.getByRole('button', { name: 'true' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'false' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(onChange).toHaveBeenLastCalledWith('secret', '');
  });

  it('tabs between fields; Space toggles a chip while Enter runs the command', async () => {
    const user = userEvent.setup();
    const { onChange, onSubmit, onCancel } = setup();
    // The first field has focus, then the cancel-less tab order walks sides, true, false.
    expect(screen.getByRole('textbox', { name: 'sides' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'true' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith('secret', 'true');
    await user.tab();
    expect(screen.getByRole('button', { name: 'false' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
