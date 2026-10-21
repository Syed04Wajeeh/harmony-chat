import { useMemo } from 'react';
import type { Channel, User } from '@harmony/shared';
import type { ConnectionStatus, RealtimeClient } from '../api/realtime.js';
import { useChannelMessages } from '../hooks/useChannelMessages.js';
import { Composer } from './Composer.js';
import { MessageList, toViewItems } from './MessageList.js';

interface ChannelViewProps {
  channel: Channel;
  me: User;
  client: RealtimeClient;
  status: ConnectionStatus;
}

export function ChannelView({ channel, me, client, status }: ChannelViewProps) {
  const chat = useChannelMessages(channel.id, client, status);
  const { messages, outbox } = chat;
  const items = useMemo(() => toViewItems(messages, outbox, me), [messages, outbox, me]);

  return (
    <main className="channel-view">
      <header className="channel-header">
        <span className="hash">#</span>
        <h1>{channel.name}</h1>
        {channel.topic && <span className="topic">{channel.topic}</span>}
      </header>
      {chat.loadError && <p className="banner">{chat.loadError}</p>}
      <MessageList
        items={items}
        hasMore={chat.hasMore}
        loaded={chat.loaded}
        loadingOlder={chat.loadingOlder}
        onLoadOlder={() => void chat.loadOlder()}
      />
      <Composer
        channelName={channel.name ?? channel.dmUser?.displayName ?? ''}
        disabled={status !== 'open'}
        onSend={chat.send}
      />
    </main>
  );
}
