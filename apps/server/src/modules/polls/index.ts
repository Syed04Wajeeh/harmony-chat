import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ChannelParams,
  CreatePollBody,
  Message,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_SEPARATOR,
  Poll,
  PollParams,
  PollSettings,
  PollsVoteFrame,
  VotePollBody,
  splitPollOptions,
} from '@harmony/shared';
import { defineModule } from '../types.js';
import { PollService, type PollsConfig } from './service.js';

const Config = z.object({
  POLLS_VOTE_RATE_MAX: z.coerce.number().int().min(1).default(30),
  POLLS_VOTE_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(10),
});

/**
 * Polls: a message with a question and 2 to 10 options. The message row carries the `polls`
 * marker, the options and votes live in this module's tables, and tallies reach clients as
 * `message.modules.polls` (history) and `polls.updated` frames (live).
 */
export const polls = defineModule<PollsConfig, PollSettings>({
  id: 'polls',
  name: 'Polls',
  description: 'Ask a question and let people vote, from the composer or with /poll.',
  optional: true,
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  config: Config,
  guildSettings: PollSettings,

  register(ctx) {
    const service = new PollService(ctx);
    ctx.permissions.define('create', 'Create polls');
    ctx.permissions.define('vote', 'Vote in polls');
    ctx.messages.decorate((ids, db) => service.snapshots(ids, db));

    ctx.commands.register({
      name: 'poll',
      description: 'Ask a question and let people vote',
      options: [
        {
          name: 'question',
          description: 'What do you want to ask?',
          type: 'string',
          required: true,
        },
        {
          name: 'options',
          description: `${String(POLL_MIN_OPTIONS)} to ${String(POLL_MAX_OPTIONS)} choices, separated by ${POLL_OPTION_SEPARATOR}`,
          type: 'string',
          required: true,
        },
        { name: 'multiple', description: 'Allow more than one answer', type: 'boolean' },
      ],
      async handler({ user, channelId, options }) {
        await service.create(user, channelId, {
          question: String(options['question'] ?? ''),
          options: splitPollOptions(String(options['options'] ?? '')),
          multiple: options['multiple'] === true,
        });
        return undefined;
      },
    });

    ctx.ws.on(
      'polls.vote',
      PollsVoteFrame,
      async (frame, caller) => {
        await service.vote(caller.user, frame.messageId, frame.optionIds);
      },
      { scope: 'messages.write' },
    );

    ctx.routes((app) => {
      app.post(
        '/channels/:id/polls',
        {
          config: { scope: 'messages.write', module: 'polls', moduleScope: 'channel' },
          schema: { params: ChannelParams, body: CreatePollBody, response: { 201: Message } },
        },
        async (request, reply) =>
          reply.code(201).send(await service.create(request.user, request.params.id, request.body)),
      );

      app.get(
        '/polls/:id',
        {
          config: { scope: 'messages.read', module: 'polls', moduleScope: 'message' },
          schema: { params: PollParams, response: { 200: Poll } },
        },
        (request) => service.get(request.user, request.params.id),
      );

      app.put(
        '/polls/:id/votes',
        {
          config: { scope: 'messages.write', module: 'polls', moduleScope: 'message' },
          schema: { params: PollParams, body: VotePollBody, response: { 200: Poll } },
        },
        (request) => service.vote(request.user, request.params.id, request.body.optionIds),
      );

      app.post(
        '/polls/:id/close',
        {
          config: { scope: 'messages.write', module: 'polls', moduleScope: 'message' },
          schema: { params: PollParams, response: { 200: Poll } },
        },
        (request) => service.close(request.user, request.params.id),
      );
    });
  },
});
