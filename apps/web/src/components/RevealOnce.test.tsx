import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevealOnce } from './RevealOnce.js';
import { SecretsDialog } from './settings/SecretsView.js';

afterEach(() => vi.restoreAllMocks());

describe('RevealOnce', () => {
  it('shows the value with a warning that it will not be shown again', () => {
    render(<RevealOnce label="Bot token" value="hb_1_secret" hint="Keep it out of git." />);
    expect(screen.getByLabelText('Bot token')).toHaveValue('hb_1_secret');
    expect(screen.getByRole('note')).toHaveTextContent("You won't see this again");
    expect(screen.getByRole('note')).toHaveTextContent('Keep it out of git.');
  });

  it('copies the value and confirms', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<RevealOnce label="Webhook URL" value="https://chat.example.com/api/webhooks/1/abc" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://chat.example.com/api/webhooks/1/abc');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('says so when the clipboard is unavailable', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<RevealOnce label="Bot token" value="hb_1_secret" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('copy it by hand');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });
});

describe('SecretsDialog', () => {
  it('shows every secret and drops them when closed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <SecretsDialog
        title="Bot created"
        secrets={[
          { label: 'Bot token', value: 'hb_1_aaa' },
          { label: 'Signing secret', value: 'hsk_bbb' },
        ]}
        onClose={onClose}
      />,
    );
    expect(screen.getByLabelText('Bot token')).toHaveValue('hb_1_aaa');
    expect(screen.getByLabelText('Signing secret')).toHaveValue('hsk_bbb');

    await user.click(screen.getByRole('button', { name: /I have saved these/ }));
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<SecretsDialog title="Bot created" secrets={null} onClose={onClose} />);
    expect(screen.queryByDisplayValue('hb_1_aaa')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SecretsDialog
        title="New token"
        secrets={[{ label: 'Bot token', value: 'x' }]}
        onClose={onClose}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
