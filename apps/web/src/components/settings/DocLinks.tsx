import type { ReactNode } from 'react';

/**
 * Where the repository's docs are published, if anywhere (for example a source browser URL
 * ending in the repository root). Without it the guides are named by path.
 */
const DOCS_BASE = (import.meta.env['VITE_DOCS_BASE_URL'] as string | undefined)?.replace(/\/$/, '');

function Doc({ path, children }: { path: string; children: ReactNode }) {
  return DOCS_BASE ? (
    <a href={`${DOCS_BASE}/${path}`} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <>
      {children} (<code>{path}</code>)
    </>
  );
}

export function DocLinks() {
  return (
    <ul className="doc-links">
      <li>
        <strong>Uptime Kuma:</strong> add a notification of type <em>Discord</em> and paste the URL.{' '}
        <Doc path="examples/uptime-kuma.md">Setup guide</Doc>
      </li>
      <li>
        <strong>Scripts and cron jobs:</strong> POST JSON with <code>content</code> or{' '}
        <code>embeds</code>. <Doc path="examples/post-from-script.sh">Example script</Doc>
      </li>
      <li>
        <strong>Reaching Harmony from another host or container:</strong>{' '}
        <Doc path="docs/integrations.md">Integration ingress</Doc>
      </li>
    </ul>
  );
}
