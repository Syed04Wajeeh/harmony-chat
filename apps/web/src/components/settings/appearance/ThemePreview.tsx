import { useMemo, type CSSProperties } from 'react';
import {
  isValidTokenValue,
  type ThemeBase,
  type ThemeTokens,
  type SemanticToken,
} from '@harmony/shared';
import { completeTokens } from '../../../lib/appearance.js';
import { Avatar } from '../../Avatar.js';
import { Embeds } from '../../Embeds.js';
import { Markdown } from '../../Markdown.js';

/** Inline custom properties for a scoped container; everything inside reads this theme, not the app's. */
export function scopeStyle(theme: { base: ThemeBase; tokens: ThemeTokens }): CSSProperties {
  const style: Record<string, string> & CSSProperties = { colorScheme: theme.base };
  for (const [name, value] of Object.entries(completeTokens(theme))) {
    if (isValidTokenValue(name as SemanticToken, value)) style[`--${name}`] = value;
  }
  return style;
}

/** A tiny layout (rail, channel list, two messages, composer) painted with the theme's tokens. */
export function ThemeMiniPreview({ theme }: { theme: { base: ThemeBase; tokens: ThemeTokens } }) {
  const style = useMemo(() => scopeStyle(theme), [theme]);
  return (
    <div className="mini-preview" style={style} aria-hidden="true">
      <div className="mini-rail">
        <i data-active />
        <i />
        <i />
      </div>
      <div className="mini-side">
        <b />
        <i data-active />
        <i />
        <i />
      </div>
      <div className="mini-chat">
        <div className="mini-message">
          <u />
          <span>
            <b />
            <i />
          </span>
        </div>
        <div className="mini-message" data-mention>
          <u />
          <span>
            <b />
            <i />
          </span>
        </div>
        <div className="mini-composer">
          <i />
          <em />
        </div>
      </div>
    </div>
  );
}

const ADA = { id: 'preview-ada', displayName: 'Ada', avatarUrl: null };
const LINUS = { id: 'preview-linus', displayName: 'Linus', avatarUrl: null };
const CODE = 'pnpm test --run';
const EMBED = [
  {
    title: 'Deploy finished',
    description: 'harmony-web is live on all instances.',
    color: 0x5fb89a,
    fields: [{ name: 'Duration', value: '41s', inline: true }],
  },
];
const noName = () => undefined;

/** Real chat components inside a container carrying the draft theme. */
export function ChatPreview({ theme }: { theme: { base: ThemeBase; tokens: ThemeTokens } }) {
  const style = useMemo(() => scopeStyle(theme), [theme]);
  return (
    <div className="chat-preview" style={style} aria-label="Theme preview" role="group">
      <ul className="chat-preview-messages">
        <li className="message" data-harmony="message">
          <div className="message-row">
            <div className="message-gutter">
              <Avatar user={LINUS} size={40} />
            </div>
            <div className="message-body">
              <div className="message-header">
                <span className="message-author">Linus</span>
                <time>Today at 6:42 PM</time>
              </div>
              <div className="message-content">
                <p>Friday works for me. I will bring the good tea.</p>
                <Markdown content={'```\n' + CODE + '\n```'} nameOf={noName} meId="none" />
              </div>
            </div>
          </div>
        </li>
        <li className="message" data-mentioned data-harmony="message">
          <div className="message-row">
            <div className="message-gutter">
              <Avatar user={ADA} size={40} />
            </div>
            <div className="message-body">
              <div className="message-header">
                <span className="message-author">Ada</span>
                <time>Today at 6:44 PM</time>
              </div>
              <div className="message-content">
                <p>
                  <span className="mention mention-me">@Linus</span> can you check the{' '}
                  <code className="md-code">reading-list</code> file? See{' '}
                  <a href="#preview" onClick={(event) => event.preventDefault()}>
                    the notes
                  </a>
                  .
                </p>
              </div>
              <Embeds embeds={EMBED} nameOf={noName} meId="none" />
            </div>
          </div>
        </li>
      </ul>
      <div className="chat-preview-actions">
        <button type="button" className="button button-primary" tabIndex={-1}>
          Primary
        </button>
        <button type="button" className="button" tabIndex={-1}>
          Secondary
        </button>
        <button type="button" className="button button-danger" tabIndex={-1}>
          Danger
        </button>
        <span className="badge">3</span>
      </div>
    </div>
  );
}
