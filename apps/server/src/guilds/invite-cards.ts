import type { Kysely } from 'kysely';
import type { DirectoryUser, SendInvitesResponse } from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { MessageService } from '../messages/service.js';
import type { RateLimiter } from '../rate-limit.js';
import type { GuildService } from './service.js';

/**
 * Invites people by DM. The card is an ordinary message whose embed carries `invite.code`; the
 * client looks the guild up through the invite preview, so the normal send path does no extra work.
 */
export class InviteCardService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly guilds: GuildService,
    private readonly channels: ChannelService,
    private readonly messages: MessageService,
    private readonly limiter: RateLimiter,
  ) {}

  async send(
    actor: DirectoryUser,
    guildId: string,
    rawUserIds: readonly string[],
  ): Promise<SendInvitesResponse> {
    // Permission first, so a stranger learns nothing (not even the limit) about the guild.
    const { code, guildName } = await this.guilds.shareableInvite(actor, guildId);
    if (!(await this.limiter.consume(actor.id))) {
      throw new AppError(429, 'rate_limited', 'You are sending invites too quickly');
    }

    const userIds = [...new Set(rawUserIds)];
    const people = await this.db
      .selectFrom('users')
      .select(['id', 'kind'])
      .where('id', 'in', userIds)
      .execute();
    const members = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', guildId)
      .where('user_id', 'in', userIds)
      .execute();
    const human = new Set(people.filter((p) => p.kind === 'human').map((p) => p.id));
    const joined = new Set(members.map((m) => m.user_id));

    const result: SendInvitesResponse = { code, sent: [], skipped: [] };
    for (const userId of userIds) {
      if (userId === actor.id || !human.has(userId)) {
        result.skipped.push({ userId, reason: 'unavailable' });
      } else if (joined.has(userId)) {
        result.skipped.push({ userId, reason: 'already_member' });
      } else {
        const dm = await this.channels.openDm(actor, userId);
        const message = await this.messages.send({
          author: actor,
          channelId: dm.id,
          content: `${actor.displayName} invited you to join ${guildName}`,
          embeds: [
            {
              title: guildName,
              description: 'You have been invited to join this server.',
              invite: { code },
            },
          ],
        });
        result.sent.push({ userId, channelId: dm.id, messageId: message.id });
      }
    }
    return result;
  }
}
