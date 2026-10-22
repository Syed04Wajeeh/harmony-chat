import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BuiltinCommands, toGuildCommand } from '../../src/modules/builtin-commands.js';
import { DomainEvents } from '../../src/modules/domain-events.js';
import { ModuleFrames } from '../../src/modules/ws-frames.js';
import { MessageDecorators } from '../../src/messages/decorators.js';

const quiet = () => ({ warn: vi.fn() });

describe('DomainEvents', () => {
  it('does nothing without handlers', () => {
    expect(() =>
      new DomainEvents(quiet()).emit('member.left', { guildId: '1', userId: '2' }),
    ).not.toThrow();
  });

  it('runs every handler and never waits for them', async () => {
    const events = new DomainEvents(quiet());
    const order: string[] = [];
    events.on('member.left', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    events.on('member.left', () => void order.push('fast'));
    events.emit('member.left', { guildId: '1', userId: '2' });
    order.push('emit returned');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual(['fast', 'emit returned', 'slow']);
  });

  it('logs a throwing or rejecting handler and keeps going', async () => {
    const log = quiet();
    const events = new DomainEvents(log);
    const ok = vi.fn();
    events.on('member.left', () => {
      throw new Error('sync boom');
    });
    events.on('member.left', () => Promise.reject(new Error('async boom')));
    events.on('member.left', ok);
    expect(() => events.emit('member.left', { guildId: '1', userId: '2' })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ok).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe('BuiltinCommands', () => {
  const handler = () => undefined;

  it('validates the definition like a bot command', () => {
    const commands = new BuiltinCommands();
    expect(() =>
      commands.register('m', 'M', { name: 'Not Valid', description: 'x', handler }),
    ).toThrow();
    commands.register('m', 'M', {
      name: 'ok',
      description: 'fine',
      options: [{ name: 'text', description: 'Text', type: 'string' }],
      handler,
    });
    expect(commands.get('ok')?.definition.options).toEqual([
      { name: 'text', description: 'Text', type: 'string', required: false },
    ]);
  });

  it('rejects two modules claiming one name', () => {
    const commands = new BuiltinCommands();
    commands.register('a', 'A', { name: 'roll', description: 'x', handler });
    expect(() => commands.register('b', 'B', { name: 'roll', description: 'x', handler })).toThrow(
      /both "a" and "b"/,
    );
  });

  it('lists a built-in without a bot', () => {
    const commands = new BuiltinCommands();
    commands.register('polls', 'Polls', { name: 'poll', description: 'Ask', handler });
    const [entry] = commands.all();
    expect(entry && toGuildCommand(entry)).toMatchObject({
      name: 'poll',
      botId: null,
      botName: 'Polls',
      moduleId: 'polls',
    });
  });
});

describe('ModuleFrames', () => {
  const schema = z.object({ type: z.literal('demo.ping'), n: z.number() });
  const registered = () => {
    const frames = new ModuleFrames();
    frames.register('demo', 'demo.ping', { schema, scope: undefined, run: () => undefined });
    return frames;
  };

  it('only accepts frame types named after the module', () => {
    const frames = new ModuleFrames();
    const handler = { schema, scope: undefined, run: () => undefined };
    expect(() => frames.register('demo', 'other.ping', handler)).toThrow(/"demo\.<name>"/);
    expect(() => frames.register('demo', 'demo.Bad Name', handler)).toThrow();
    frames.register('demo', 'demo.ping', handler);
    expect(() => frames.register('demo', 'demo.ping', handler)).toThrow(/twice/);
  });

  it('validates against the module schema', () => {
    const frames = registered();
    expect(frames.parse({ type: 'demo.ping', n: 1 })).toMatchObject({ frame: { n: 1 } });
    expect(frames.parse({ type: 'demo.ping', n: 'x' })).toBe('invalid');
  });

  it('leaves unknown types to the caller', () => {
    expect(registered().parse({ type: 'demo.other' })).toBeNull();
    expect(registered().parse({ type: 'explode' })).toBeNull();
    expect(registered().parse(null)).toBeNull();
  });
});

describe('MessageDecorators', () => {
  it('allows one decorator per module', () => {
    const decorators = new MessageDecorators();
    decorators.register('polls', () => Promise.resolve(new Map<string, unknown>()));
    expect(decorators.get('polls')).toBeDefined();
    expect(decorators.get('other')).toBeUndefined();
    expect(() =>
      decorators.register('polls', () => Promise.resolve(new Map<string, unknown>())),
    ).toThrow(/already registered/);
  });
});
