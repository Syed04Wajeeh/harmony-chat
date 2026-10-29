import { useEffect, useMemo } from 'react';
import { useNameOf } from '../../hooks/useNameOf.js';
import { loadPanels, panelsOf, usePanels } from '../../store/panels.js';
import type { LocalInteraction } from '../../store/interactions.js';
import { appStore, useApp } from '../../store/store.js';
import { ChannelHeader } from '../ChannelHeader.js';
import { MessageContext, type MessageHandlers } from '../chat-context.js';
import { InteractionItem } from '../InteractionItem.js';
import { PanelCard } from './PanelCard.js';

const NO_INTERACTIONS: readonly LocalInteraction[] = [];
const noop = () => undefined;

/** A channel that shows the panels bots publish in it instead of a message list. */
export function DashboardView({ channelId }: { channelId: string }) {
  const channel = useApp((state) => state.channels[channelId]);
  const panels = usePanels(panelsOf(channelId));
  const interactions = useApp((state) => state.interactions[channelId]) ?? NO_INTERACTIONS;
  const meId = useApp((state) => state.me?.id ?? '');
  const nameOf = useNameOf();

  useEffect(() => {
    const store = appStore.getState();
    store.setActiveChannel(channelId);
    void loadPanels(channelId);
    const timer = setInterval(() => appStore.getState().pruneInteractions(), 1000);
    return () => {
      clearInterval(timer);
      appStore.getState().setActiveChannel(null);
    };
  }, [channelId]);

  // Replies to button clicks use the message components, which need these (inert) handlers.
  const handlers = useMemo<MessageHandlers>(
    () => ({
      meId,
      nameOf,
      editingId: null,
      highlightId: null,
      onReply: noop,
      onStartEdit: noop,
      onCancelEdit: noop,
      onSaveEdit: () => Promise.resolve(),
      onDelete: noop,
      onCopy: noop,
      onOpenSheet: noop,
      onJump: noop,
      onOpenImage: noop,
    }),
    [meId, nameOf],
  );

  if (!channel) return null;
  return (
    <MessageContext.Provider value={handlers}>
      <section
        className="channel-view dashboard-view"
        aria-label={`Dashboard ${channel.name ?? ''}`}
      >
        <ChannelHeader channel={channel} />
        <div className="dashboard-scroll">
          {panels === undefined ? (
            <p className="empty-note" role="status">
              Loading panels…
            </p>
          ) : panels.length === 0 ? (
            <div className="empty-state">
              <h2>Nothing here yet</h2>
              <p>
                A bot with the Panels permission can publish charts, stats and buttons to this
                dashboard.
              </p>
            </div>
          ) : (
            <div className="dashboard-panels">
              {panels.map((panel) => (
                <PanelCard key={panel.id} panel={panel} />
              ))}
            </div>
          )}
          {interactions.length > 0 && (
            <ul className="dashboard-responses" aria-live="polite">
              {interactions.map((item) => (
                <InteractionItem key={item.key} item={item} channelId={channelId} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </MessageContext.Provider>
  );
}
