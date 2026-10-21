import { HealthResponse } from '@harmony/shared';
import { useEffect, useState } from 'react';

type Status = 'checking' | 'ready' | 'degraded' | 'unreachable';

async function fetchStatus(signal: AbortSignal): Promise<Status> {
  const res = await fetch('/readyz', { signal });
  const body = HealthResponse.parse(await res.json());
  return body.status === 'ok' ? 'ready' : 'degraded';
}

export function App() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetchStatus(controller.signal)
      .then(setStatus)
      .catch(() => {
        if (!controller.signal.aborted) setStatus('unreachable');
      });
    return () => controller.abort();
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>Harmony</h1>
      <p>Server status: {status}</p>
    </main>
  );
}
