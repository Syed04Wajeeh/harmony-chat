import { afterEach, describe, expect, it, vi } from 'vitest';
import { channel, message, user } from '../test/factories.js';
import {
  NAVIGATE_EVENT,
  closeWindow,
  disconnectServer,
  hasCustomTitleBar,
  isDesktopApp,
  isWindowMaximized,
  minimizeWindow,
  startWindowDrag,
  toggleMaximizeWindow,
  notificationFor,
  notifyDesktop,
  onDesktopNavigate,
  parseRoute,
  releasesUrl,
  setDesktopBadge,
} from './desktopBridge.js';

const NOW = Date.parse('2026-10-22T09:00:30.000Z');
const nameOf = (id: string) => (id === '1' ? 'Ada' : undefined);
const mention = (overrides = {}) => message('100', { mentions: ['1'], ...overrides });

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('without the desktop shell', () => {
  it('is a no-op', () => {
    expect(isDesktopApp()).toBe(false);
    expect(() => {
      notifyDesktop({ title: 't', body: 'b', route: '/' });
      setDesktopBadge(3);
    }).not.toThrow();
  });
});

describe('with the desktop shell', () => {
  it('routes notifications and the badge through its commands', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.__TAURI_INTERNALS__ = { invoke };
    expect(isDesktopApp()).toBe(true);

    notifyDesktop({ title: 'Linus', body: 'hi', route: '/channels/5/10' });
    setDesktopBadge(4);

    expect(invoke).toHaveBeenNthCalledWith(1, 'notify', {
      title: 'Linus',
      body: 'hi',
      route: '/channels/5/10',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_badge', { count: 4 });
  });

  it('ignores a rejected command', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: 'forbidden' });
    window.__TAURI_INTERNALS__ = { invoke };
    expect(() => setDesktopBadge(1)).not.toThrow();
    await Promise.resolve();
  });

  it('delivers the route of a clicked notification until unsubscribed', () => {
    const handler = vi.fn();
    const off = onDesktopNavigate(handler);
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: '/channels/5/10' }));
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: 42 }));
    off();
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: '/later' }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('/channels/5/10');
  });
});

describe('notificationFor', () => {
  const text = channel('10', { name: 'general' });
  const dm = channel('11', { kind: 'dm', guildId: null, name: null });

  it('notifies for a mention in a channel and decodes the mention', () => {
    const result = notificationFor(mention({ content: 'hey <@1>, look' }), text, '1', nameOf, NOW);
    expect(result).toEqual({
      title: 'Linus in #general',
      body: 'hey @Ada, look',
      route: '/channels/5/10?message=100',
    });
  });

  it('notifies for every direct message', () => {
    const result = notificationFor(message('101', { channelId: '11' }), dm, '1', nameOf, NOW);
    expect(result).toMatchObject({ title: 'Linus', route: '/channels/@me/11?message=101' });
  });

  it('stays quiet when nothing is addressed to me', () => {
    expect(notificationFor(message('102'), text, '1', nameOf, NOW)).toBeNull();
    expect(notificationFor(mention({ mentions: ['3'] }), text, '1', nameOf, NOW)).toBeNull();
  });

  it('stays quiet for my own messages, deleted messages and unknown channels', () => {
    expect(notificationFor(mention({ author: user('1') }), text, '1', nameOf, NOW)).toBeNull();
    expect(notificationFor(mention({ deleted: true }), text, '1', nameOf, NOW)).toBeNull();
    expect(notificationFor(mention(), undefined, '1', nameOf, NOW)).toBeNull();
    expect(notificationFor(mention(), text, undefined, nameOf, NOW)).toBeNull();
  });

  it('skips old messages replayed after a reconnect', () => {
    const old = mention({ createdAt: '2026-10-22T08:00:00.000Z' });
    expect(notificationFor(old, text, '1', nameOf, NOW)).toBeNull();
  });

  it('shortens long text and describes attachment-only messages', () => {
    const long = notificationFor(mention({ content: 'x'.repeat(500) }), text, '1', nameOf, NOW);
    expect(long?.body).toHaveLength(300);
    expect(long?.body.endsWith('…')).toBe(true);

    const attachment = {
      id: '00000000-0000-4000-8000-000000000000',
      filename: 'a.png',
      contentType: 'image/png',
      sizeBytes: 1,
      width: 1,
      height: 1,
      url: '/x',
    };
    const result = notificationFor(
      mention({ content: '', attachments: [attachment] }),
      text,
      '1',
      nameOf,
      NOW,
    );
    expect(result?.body).toBe('Sent an attachment');
  });
});

describe('parseRoute', () => {
  it('extracts the message to jump to', () => {
    expect(parseRoute('/channels/5/10?message=100')).toEqual({
      path: '/channels/5/10',
      channelId: '10',
      messageId: '100',
    });
    expect(parseRoute('/channels/@me/11')).toEqual({ path: '/channels/@me/11' });
  });
});

describe('releasesUrl', () => {
  it('is null unless a web address is configured', () => {
    expect(releasesUrl(undefined)).toBeNull();
    expect(releasesUrl('')).toBeNull();
    expect(releasesUrl('javascript:alert(1)')).toBeNull();
    expect(releasesUrl('https://example.com/releases')).toBe('https://example.com/releases');
  });
});

describe('window controls', () => {
  it('are no-ops without the shell', async () => {
    expect(hasCustomTitleBar()).toBe(false);
    expect(() => {
      minimizeWindow();
      toggleMaximizeWindow();
      closeWindow();
      startWindowDrag();
    }).not.toThrow();
    expect(await isWindowMaximized()).toBe(false);
  });

  it('call their commands with no arguments', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.__TAURI_INTERNALS__ = { invoke };
    minimizeWindow();
    toggleMaximizeWindow();
    closeWindow();
    startWindowDrag();
    disconnectServer();
    expect(invoke.mock.calls).toEqual([
      ['window_minimize', {}],
      ['window_toggle_maximize', {}],
      ['window_close', {}],
      ['window_start_dragging', {}],
      ['disconnect_server', {}],
    ]);
  });

  it('reports the maximized state, and false when the call is refused', async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue(true) };
    expect(await isWindowMaximized()).toBe(true);
    window.__TAURI_INTERNALS__ = { invoke: vi.fn().mockRejectedValue({ code: 'forbidden' }) };
    expect(await isWindowMaximized()).toBe(false);
  });

  it('shows the custom title bar only in the desktop app on Windows', () => {
    const agent = vi.spyOn(navigator, 'userAgent', 'get');
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    agent.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(hasCustomTitleBar()).toBe(true);
    agent.mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    expect(hasCustomTitleBar()).toBe(false);
    agent.mockRestore();
  });
});
