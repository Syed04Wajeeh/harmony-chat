import { useApp } from '../store/store.js';

export function ConnectionBanner() {
  const connection = useApp((state) => state.connection);
  if (connection === 'open') return null;
  return (
    <div className="connection-banner" role="status">
      <span className="spinner" aria-hidden="true" />
      {connection === 'connecting' ? 'Connecting…' : 'Connection lost. Reconnecting…'}
    </div>
  );
}
