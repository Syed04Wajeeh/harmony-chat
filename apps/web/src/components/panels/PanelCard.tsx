import { useState } from 'react';
import type { Panel } from '@harmony/shared';
import { api } from '../../api/client.js';
import { useGuildAccess } from '../../hooks/usePermission.js';
import { formatTimestamp } from '../../lib/time.js';
import { attempt } from '../../store/actions.js';
import { usePanels } from '../../store/panels.js';
import { useApp } from '../../store/store.js';
import { PinIcon, TrashIcon } from '../Icons.js';
import { ConfirmDialog } from '../Overlay.js';
import { PanelBlock } from './Blocks.js';

/** A bot's panel: a titled card holding its blocks in a grid (two columns when there is room). */
export function PanelCard({ panel }: { panel: Panel }) {
  const channel = useApp((state) => state.channels[panel.channelId]);
  const botName = useApp((state) => state.users[panel.botId]?.displayName);
  const meId = useApp((state) => state.me?.id);
  const access = useGuildAccess(channel?.guildId ?? '', channel?.guildId ? channel.id : undefined);
  const canManage = access.has('manage_channels') || channel?.createdBy === meId;
  const [deleting, setDeleting] = useState(false);
  const title = panel.view.title ?? panel.key;

  async function togglePin() {
    const updated = await attempt(
      api.setPanelPinned(panel.id, !panel.pinned),
      'Could not change the pin',
    );
    if (updated) {
      usePanels
        .getState()
        .receive({ type: 'panel.updated', channelId: panel.channelId, panel: updated });
    }
  }

  return (
    <article className="panel-card" aria-label={title} data-panel-key={panel.key}>
      <header className="panel-card-header">
        <div className="panel-card-heading">
          <h3>{title}</h3>
          <p>
            {botName ?? 'A bot'} · updated{' '}
            <time dateTime={panel.updatedAt}>{formatTimestamp(panel.updatedAt)}</time>
          </p>
        </div>
        {canManage && (
          <div className="panel-card-tools">
            <button
              type="button"
              className="icon-button icon-button-small"
              aria-pressed={panel.pinned}
              aria-label={panel.pinned ? 'Unpin from the channel' : 'Pin above the messages'}
              title={panel.pinned ? 'Unpin from the channel' : 'Pin above the messages'}
              onClick={() => void togglePin()}
            >
              <PinIcon width={18} height={18} />
            </button>
            <button
              type="button"
              className="icon-button icon-button-small"
              aria-label="Remove panel"
              title="Remove panel"
              onClick={() => setDeleting(true)}
            >
              <TrashIcon width={18} height={18} />
            </button>
          </div>
        )}
      </header>
      <div className="panel-grid">
        {panel.view.blocks.map((block, index) => (
          <PanelBlock key={block.id ?? index} block={block} panel={panel} />
        ))}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Remove ${title}?`}
        description="The bot can publish it again. This removes it for everyone."
        confirmLabel="Remove"
        danger
        onConfirm={() => void attempt(api.deletePanel(panel.id), 'Could not remove the panel')}
      />
    </article>
  );
}
