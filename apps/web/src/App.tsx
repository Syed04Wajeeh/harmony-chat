import { useState } from 'react';
import { fetchChannels, fetchMe } from './api/client.js';
import { ChannelView } from './components/ChannelView.js';
import { Sidebar } from './components/Sidebar.js';
import { useAsync } from './hooks/useAsync.js';
import { useRealtime } from './hooks/useRealtime.js';

async function loadBootstrap(signal: AbortSignal) {
  const [me, channels] = await Promise.all([fetchMe(signal), fetchChannels(signal)]);
  return { me, channels };
}

export function App() {
  const boot = useAsync(loadBootstrap);
  const { client, status } = useRealtime();
  const [selected, setSelected] = useState<string | null>(null);

  if (boot.status === 'loading') return <div className="splash">Loading...</div>;
  if (boot.status === 'error') {
    return (
      <div className="splash error">
        <h1>Cannot reach Harmony</h1>
        <p>{boot.error.message}</p>
      </div>
    );
  }

  const { me, channels } = boot.value;
  const channel = channels.find((c) => c.id === selected) ?? channels[0];

  return (
    <div className="app">
      <Sidebar
        channels={channels}
        activeId={channel?.id ?? ''}
        onSelect={setSelected}
        user={me}
        status={status}
      />
      {channel ? (
        <ChannelView key={channel.id} channel={channel} me={me} client={client} status={status} />
      ) : (
        <main className="channel-view splash">No channels yet.</main>
      )}
    </div>
  );
}
