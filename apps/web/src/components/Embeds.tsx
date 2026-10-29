import type { Embed } from '@harmony/shared';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { embedColor, hasVisibleContent, safeHttpUrl } from '../lib/embeds.js';
import { formatAbsolute, formatTimestamp } from '../lib/time.js';
import { InviteCard } from './InviteCard.js';
import { Markdown } from './Markdown.js';

interface Props {
  embeds: readonly Embed[];
  nameOf: (userId: string) => string | undefined;
  meId: string;
}

/**
 * External images load straight from their host, without a referrer. A proxy would hide the
 * reader's address from that host too; see NOTES.md for why it was left out.
 */
function RemoteImage({ src, className }: { src: string | null; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function MaybeLink({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function EmbedCard({ embed, nameOf, meId }: { embed: Embed } & Omit<Props, 'embeds'>) {
  if (embed.invite) return <InviteCard code={embed.invite.code} />;
  const color = embedColor(embed.color);
  const fields = embed.fields ?? [];
  const thumbnail = safeHttpUrl(embed.thumbnail?.url);
  const image = safeHttpUrl(embed.image?.url);
  const authorIcon = safeHttpUrl(embed.author?.icon_url);
  const footerIcon = safeHttpUrl(embed.footer?.icon_url);
  const md = (content: string) => <Markdown content={content} nameOf={nameOf} meId={meId} />;

  return (
    <article
      className="embed"
      data-harmony="embed"
      style={color ? ({ '--embed-color': color } as CSSProperties) : undefined}
    >
      {embed.author?.name && (
        <div className="embed-author">
          <RemoteImage src={authorIcon} className="embed-author-icon" />
          <MaybeLink href={safeHttpUrl(embed.author.url)}>{embed.author.name}</MaybeLink>
        </div>
      )}
      {embed.title && (
        <div className="embed-title">
          <MaybeLink href={safeHttpUrl(embed.url)}>{embed.title}</MaybeLink>
        </div>
      )}
      {embed.description && <div className="embed-description">{md(embed.description)}</div>}
      {fields.length > 0 && (
        <div className="embed-fields">
          {fields.map((field, index) => (
            <div key={index} className="embed-field" data-inline={field.inline || undefined}>
              <div className="embed-field-name">{field.name}</div>
              {field.value && <div className="embed-field-value">{md(field.value)}</div>}
            </div>
          ))}
        </div>
      )}
      <RemoteImage src={image} className="embed-image" />
      {(embed.footer?.text || embed.timestamp) && (
        <div className="embed-footer">
          <RemoteImage src={footerIcon} className="embed-footer-icon" />
          <span>
            {embed.footer?.text}
            {embed.footer?.text && embed.timestamp && ' · '}
            {embed.timestamp && (
              <time dateTime={embed.timestamp} title={formatAbsolute(embed.timestamp)}>
                {formatTimestamp(embed.timestamp)}
              </time>
            )}
          </span>
        </div>
      )}
      <RemoteImage src={thumbnail} className="embed-thumbnail" />
    </article>
  );
}

export function Embeds({ embeds, nameOf, meId }: Props) {
  const shown = embeds.filter(hasVisibleContent);
  if (shown.length === 0) return null;
  return (
    <div className="embeds">
      {shown.map((embed, index) => (
        <EmbedCard key={index} embed={embed} nameOf={nameOf} meId={meId} />
      ))}
    </div>
  );
}
