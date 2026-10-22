import { sql, type Generated, type Kysely } from 'kysely';
import {
  CreatePollBody,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  type DirectoryUser,
  type Message,
  type Poll,
  type PollSettings,
} from '@harmony/shared';
import type { Database } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { forbidden, notFound } from '../../messages/service.js';
import type { ModuleContext } from '../types.js';

export type PollTables = {
  polls: { message_id: string; multiple: boolean; closed_at: Date | null };
  poll_options: { id: number; message_id: string; label: string };
  poll_votes: {
    message_id: string;
    option_id: number;
    user_id: string;
    created_at: Generated<Date>;
  };
};

type PollsDb = Kysely<Database & PollTables>;

export interface PollsConfig {
  POLLS_VOTE_RATE_MAX: number;
  POLLS_VOTE_RATE_WINDOW_SECONDS: number;
}

type Ctx = ModuleContext<PollsConfig, PollSettings>;

export class PollService {
  private readonly db: PollsDb;
  private readonly voteLimiter;

  constructor(private readonly ctx: Ctx) {
    this.db = ctx.db.withTables<PollTables>();
    this.voteLimiter = ctx.limiter(
      'vote',
      ctx.config.POLLS_VOTE_RATE_MAX,
      ctx.config.POLLS_VOTE_RATE_WINDOW_SECONDS,
    );
  }

  /** The poll as a message: the question is its text, the options live in the module tables. */
  async create(user: DirectoryUser, channelId: string, body: CreatePollBody): Promise<Message> {
    const parsed = CreatePollBody.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        400,
        'invalid_poll',
        parsed.error.issues[0]?.message ??
          `A poll needs ${String(POLL_MIN_OPTIONS)} to ${String(POLL_MAX_OPTIONS)} different options`,
      );
    }
    const { question, options, multiple } = parsed.data;
    const channel = await this.ctx.channels.requireMember(channelId, user.id);
    await this.ctx.requireEnabled(channel.guild_id);
    await this.ctx.permissions.require(user, channel.guild_id, 'create', channelId);
    const settings = await this.ctx.settings.get(channel.guild_id);
    if (multiple && !settings.allowMultipleChoice) {
      throw new AppError(
        400,
        'multiple_choice_disabled',
        'Multiple-choice polls are turned off in this server',
      );
    }

    return this.ctx.messages.sendMarked(
      { author: user, channelId, content: question },
      async (trx, messageId) => {
        const tx = trx.withTables<PollTables>();
        await tx
          .insertInto('polls')
          .values({ message_id: messageId, multiple, closed_at: null })
          .execute();
        await tx
          .insertInto('poll_options')
          .values(options.map((label, index) => ({ message_id: messageId, id: index + 1, label })))
          .execute();
      },
    );
  }

  async get(user: DirectoryUser, messageId: string): Promise<Poll> {
    await this.readable(user.id, messageId);
    return this.snapshot(messageId);
  }

  /** Replaces the caller's votes with `optionIds`; an empty list retracts them. */
  async vote(user: DirectoryUser, messageId: string, optionIds: readonly number[]): Promise<Poll> {
    const target = await this.readable(user.id, messageId);
    await this.ctx.permissions.require(user, target.guild_id, 'vote', target.channel_id);
    const wanted = [...new Set(optionIds)];
    if (!(await this.voteLimiter.consume(user.id))) {
      throw new AppError(429, 'rate_limited', 'You are voting too quickly');
    }

    await this.db.transaction().execute(async (trx) => {
      // Serializes votes on one poll, so "one choice" cannot be raced past by two requests.
      const poll = await trx
        .selectFrom('polls')
        .selectAll()
        .where('message_id', '=', messageId)
        .forUpdate()
        .executeTakeFirst();
      if (!poll) throw new AppError(404, 'poll_not_found', 'This message is not a poll');
      if (poll.closed_at) throw new AppError(409, 'poll_closed', 'This poll is closed');
      if (!poll.multiple && wanted.length > 1) {
        throw new AppError(400, 'single_choice', 'This poll allows one choice');
      }
      if (wanted.length > 0) {
        const valid = await trx
          .selectFrom('poll_options')
          .select('id')
          .where('message_id', '=', messageId)
          .where('id', 'in', wanted)
          .execute();
        if (valid.length !== wanted.length) {
          throw new AppError(400, 'invalid_option', 'That option does not exist');
        }
      }
      await trx
        .deleteFrom('poll_votes')
        .where('message_id', '=', messageId)
        .where('user_id', '=', user.id)
        .execute();
      if (wanted.length > 0) {
        await trx
          .insertInto('poll_votes')
          .values(
            wanted.map((optionId) => ({
              message_id: messageId,
              option_id: optionId,
              user_id: user.id,
            })),
          )
          .execute();
      }
    });
    return this.announce(target.channel_id, messageId);
  }

  /** Only the author closes a poll; closing twice is harmless. */
  async close(user: DirectoryUser, messageId: string): Promise<Poll> {
    const target = await this.readable(user.id, messageId);
    if (target.author_id !== user.id) {
      throw new AppError(403, 'forbidden', 'Only the author can close a poll');
    }
    const closed = await this.db
      .updateTable('polls')
      .set({ closed_at: new Date() })
      .where('message_id', '=', messageId)
      .where('closed_at', 'is', null)
      .returning('message_id')
      .executeTakeFirst();
    if (closed) return this.announce(target.channel_id, messageId);
    return this.snapshot(messageId);
  }

  /** The decorator: one query for all the polls on a page of messages. */
  async snapshots(ids: string[], db: Kysely<Database>): Promise<Map<string, Poll>> {
    const { rows } = await sql<{
      message_id: string;
      multiple: boolean;
      closed_at: Date | null;
      option_id: number;
      label: string;
      voter_ids: string[];
    }>`
      select p.message_id, p.multiple, p.closed_at, o.id as option_id, o.label,
             coalesce(array_agg(v.user_id order by v.created_at, v.user_id)
                      filter (where v.user_id is not null), '{}') as voter_ids
      from polls p
      join poll_options o on o.message_id = p.message_id
      left join poll_votes v on v.message_id = o.message_id and v.option_id = o.id
      where p.message_id = any(${ids}::bigint[])
      group by p.message_id, p.multiple, p.closed_at, o.id, o.label
      order by p.message_id, o.id
    `.execute(db);

    const polls = new Map<string, Poll & { voters: Set<string> }>();
    for (const row of rows) {
      let poll = polls.get(row.message_id);
      if (!poll) {
        poll = {
          multiple: row.multiple,
          closed: row.closed_at !== null,
          closedAt: row.closed_at?.toISOString() ?? null,
          totalVoters: 0,
          options: [],
          voters: new Set(),
        };
        polls.set(row.message_id, poll);
      }
      poll.options.push({
        id: row.option_id,
        label: row.label,
        votes: row.voter_ids.length,
        voterIds: row.voter_ids,
      });
      for (const voter of row.voter_ids) poll.voters.add(voter);
    }
    return new Map(
      [...polls].map(([id, { voters, ...poll }]) => [id, { ...poll, totalVoters: voters.size }]),
    );
  }

  private async snapshot(messageId: string): Promise<Poll> {
    const poll = (await this.snapshots([messageId], this.ctx.db)).get(messageId);
    if (!poll) throw new AppError(404, 'poll_not_found', 'This message is not a poll');
    return poll;
  }

  private async announce(channelId: string, messageId: string): Promise<Poll> {
    const poll = await this.snapshot(messageId);
    await this.ctx.publish.channel(channelId, {
      type: 'polls.updated',
      channelId,
      messageId,
      poll,
    });
    return poll;
  }

  private async readable(userId: string, messageId: string) {
    const target = await this.ctx.messages.find(messageId, userId);
    if (!target.isMember) throw forbidden();
    if (target.deleted_at) throw notFound();
    await this.ctx.requireEnabled(target.guild_id);
    return target;
  }
}
