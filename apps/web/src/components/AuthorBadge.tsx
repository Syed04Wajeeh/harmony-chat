import type { AuthorBadgeKind } from '../lib/identity.js';

export function AuthorBadge({ kind }: { kind: AuthorBadgeKind }) {
  return <span className="author-badge">{kind === 'webhook' ? 'WEBHOOK' : 'BOT'}</span>;
}
