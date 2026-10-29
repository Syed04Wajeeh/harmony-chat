import { useEffect, useRef, useState } from 'react';
import type { ActionSource, Button } from '@harmony/shared';
import { api } from '../../api/client.js';
import { useGuildAccess } from '../../hooks/usePermission.js';
import { reportError } from '../../store/actions.js';
import { ACTION_PENDING_MS, usePanels } from '../../store/panels.js';
import { useApp } from '../../store/store.js';
import { ConfirmDialog } from '../Overlay.js';

interface Props {
  button: Button;
  /** The panel or message the button belongs to. */
  source: ActionSource;
  channelId: string;
}

const STYLE_CLASS = {
  primary: 'button button-primary',
  secondary: 'button',
  danger: 'button button-danger',
} as const;

const sourceId = (source: ActionSource): string =>
  'panelId' in source ? `p${source.panelId}` : `m${source.messageId}`;

/**
 * A button a bot put on a panel or a message. Clicking asks the server to call the bot; the
 * result comes back as a normal realtime frame, so the button only tracks "waiting". The
 * permission check here only greys the button out: the server checks again on every click.
 */
export function ActionButton({ button, source, channelId }: Props) {
  const key = `${sourceId(source)}:${button.id}`;
  const pending = usePanels((state) => key in state.pending);
  const guildId = useApp((state) => state.channels[channelId]?.guildId ?? '');
  const access = useGuildAccess(guildId, channelId);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const missing =
    button.requiredPermission !== undefined &&
    access.loaded &&
    !access.has(button.requiredPermission);

  async function press() {
    const nonce = crypto.randomUUID();
    usePanels.getState().startAction(key, nonce);
    // Without an answer the spinner would hang; the bot has a few seconds, then a deferred reply.
    timer.current = setTimeout(() => usePanels.getState().finishAction(nonce), ACTION_PENDING_MS);
    try {
      await api.invokeAction({ source, actionId: button.id, nonce });
    } catch (error) {
      clearTimeout(timer.current);
      usePanels.getState().finishAction(nonce);
      reportError(error, 'Could not run that action');
    }
  }

  const onClick = () => {
    if (button.confirm) setConfirming(true);
    else void press();
  };

  return (
    <>
      <button
        type="button"
        className={`${STYLE_CLASS[button.style ?? 'secondary']} action-button`}
        disabled={pending || missing}
        aria-busy={pending || undefined}
        title={missing ? `Requires the ${button.requiredPermission} permission` : undefined}
        onClick={onClick}
      >
        {pending && <span className="spinner action-spinner" aria-hidden="true" />}
        {button.label}
      </button>
      {button.confirm && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={button.confirm.title}
          description={button.confirm.body ?? ''}
          confirmLabel={button.confirm.confirmLabel ?? button.label}
          danger={button.style === 'danger'}
          onConfirm={() => void press()}
        />
      )}
    </>
  );
}

/** A row of buttons. */
export function ActionRow({
  buttons,
  source,
  channelId,
}: {
  buttons: readonly Button[];
  source: ActionSource;
  channelId: string;
}) {
  return (
    <div className="action-row">
      {buttons.map((button) => (
        <ActionButton key={button.id} button={button} source={source} channelId={channelId} />
      ))}
    </div>
  );
}
