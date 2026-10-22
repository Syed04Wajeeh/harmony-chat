import { z } from 'zod';
import { GuildParams, Id } from '@harmony/shared';
import { AppError } from '../../../src/errors.js';
import { defineModule, type DomainEventMap } from '../../../src/modules/types.js';

/** What the probe's event handlers saw. */
export const seen: DomainEventMap['message.created'][] = [];

const EchoFrame = z.object({
  type: z.literal('probe.echo'),
  channelId: Id,
  text: z.string().max(50),
});

/** A module that touches every extension point, so tests can check the contract end to end. */
export const probe = defineModule({
  id: 'probe',
  name: 'Probe',
  description: 'Exercises every extension point.',
  optional: true,
  config: z.object({ PROBE_GREETING: z.string().default('hello') }),
  guildSettings: z.object({
    limit: z.number().int().min(1).max(5).default(3),
    mode: z.enum(['quiet', 'loud']).default('quiet'),
  }),

  register(ctx) {
    ctx.permissions.define('use', 'Use the probe');

    ctx.routes((app) => {
      app.get(
        '/guilds/:id/probe',
        {
          config: { scope: 'channels.read', module: 'probe', moduleScope: 'guild' },
          schema: { params: GuildParams },
        },
        async (request) => ({
          greeting: ctx.config.PROBE_GREETING,
          settings: await ctx.settings.get(request.params.id),
        }),
      );
      app.get(
        '/guilds/:id/probe-explicit',
        { config: { scope: 'channels.read' }, schema: { params: GuildParams } },
        async (request) => {
          await ctx.requireEnabled(request.params.id);
          return { ok: true };
        },
      );
      app.get('/probe/foreign-publish', { config: { scope: 'any' } }, async () => {
        try {
          await ctx.publish.channel('1', { type: 'other.frame' });
          return { rejected: false };
        } catch (error) {
          return { rejected: true, message: (error as Error).message };
        }
      });
    });

    ctx.ws.on('probe.echo', EchoFrame, async (frame, caller) => {
      await ctx.channels.requireMember(frame.channelId, caller.user.id);
      await ctx.publish.channel(frame.channelId, {
        type: 'probe.echoed',
        text: frame.text,
        by: caller.user.id,
      });
    });
    ctx.ws.on('probe.scoped', z.object({ type: z.literal('probe.scoped') }), () => undefined, {
      scope: 'messages.write',
    });

    ctx.events.on('message.created', (event) => void seen.push(event));
    ctx.events.on('message.created', () => {
      throw new Error('a handler that always fails');
    });

    ctx.commands.register({
      name: 'probe',
      description: 'Say hello',
      options: [{ name: 'who', description: 'Who to greet', type: 'string', required: true }],
      handler: ({ user, options }) => {
        if (options['who'] === 'nobody') throw new AppError(400, 'nobody', 'Nobody to greet');
        return {
          content: `${ctx.config.PROBE_GREETING}, ${String(options['who'])} (from ${user.login})`,
        };
      },
    });
    ctx.commands.register({
      name: 'whisper',
      description: 'Reply only to the caller',
      handler: () => ({ content: 'psst', ephemeral: true }),
    });
  },
});

/** Needs the probe: for the dependency rules. */
export const probeChild = defineModule({
  id: 'probe-child',
  name: 'Probe child',
  description: 'Depends on the probe.',
  optional: true,
  dependsOn: ['probe'],
  register: () => undefined,
});
