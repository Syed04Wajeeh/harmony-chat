import { describe, expect, it } from 'vitest';
import { message, user } from '../test/factories.js';
import { messageIdentity, sameSender } from './identity.js';
import { buildTimeline } from './timeline.js';

describe('messageIdentity', () => {
  it('shows a plain author as is', () => {
    expect(messageIdentity(message('1'))).toMatchObject({ name: 'Linus', badge: null });
  });

  it('badges bots and webhooks', () => {
    const bot = { ...user('9', 'Echo'), isBot: true };
    expect(messageIdentity(message('1', { author: bot })).badge).toBe('bot');
    expect(messageIdentity(message('1', { author: bot, webhookId: '4' })).badge).toBe('webhook');
  });

  it('applies the per-message name and avatar of a webhook call', () => {
    const identity = messageIdentity(
      message('1', {
        author: { ...user('9', 'Kuma hook'), isBot: true },
        webhookId: '4',
        displayNameOverride: 'Uptime Kuma',
        avatarUrlOverride: 'https://example.com/kuma.png',
      }),
    );
    expect(identity.name).toBe('Uptime Kuma');
    expect(identity.avatarUser).toMatchObject({
      id: '9',
      displayName: 'Uptime Kuma',
      avatarUrl: 'https://example.com/kuma.png',
    });
  });

  it('falls back to the author for empty overrides', () => {
    const identity = messageIdentity(
      message('1', { displayNameOverride: '', avatarUrlOverride: null }),
    );
    expect(identity.name).toBe('Linus');
    expect(identity.avatarUser.avatarUrl).toBeNull();
  });
});

describe('grouping with overrides', () => {
  it('does not group webhook messages that pose as different senders', () => {
    const hook = { ...user('9', 'Hook'), isBot: true };
    const a = message('1', { author: hook, displayNameOverride: 'Kuma' });
    const b = message('2', { author: hook, displayNameOverride: 'Deploys' });
    const c = message('3', { author: hook, displayNameOverride: 'Deploys' });
    expect(sameSender(a, b)).toBe(false);
    expect(sameSender(b, c)).toBe(true);
    const items = buildTimeline([a, b, c], { unreadFromId: null });
    const grouped = items.flatMap((item) => (item.kind === 'message' ? [item.grouped] : []));
    expect(grouped).toEqual([false, false, true]);
  });
});
