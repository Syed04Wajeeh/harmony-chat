import { useEffect, useState, useSyncExternalStore } from 'react';
import { RealtimeClient, realtimeUrl, type ConnectionStatus } from '../api/realtime.js';

export function useRealtime(): { client: RealtimeClient; status: ConnectionStatus } {
  const [client] = useState(() => new RealtimeClient(realtimeUrl()));
  const status = useSyncExternalStore(
    (notify) => client.onStatus(notify),
    () => client.status,
  );

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  return { client, status };
}
