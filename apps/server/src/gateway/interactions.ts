import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { InteractionPayload } from '@harmony/shared';
import { verifySecret } from '../bots/token.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { Hub } from '../realtime/hub.js';
import { pendingKey, replyTopic, type GatewayBus } from './bus.js';

export type AskResult =
  { ok: true; response: unknown } | { ok: false; reason: 'unreachable' | 'timeout' };

const DUMMY_HASH = Buffer.alloc(32);
/** The pending marker outlives the deadline a little so a last-moment answer is still routed. */
const PENDING_GRACE_MS = 2000;

/**
 * Request/response over the gateway, across instances. The instance that took the invocation asks
 * and waits; the bot may be connected to any instance. The answer travels back the same way the
 * question went out: through Redis. A `pending` key names the instance that is waiting, and its
 * atomic GETDEL makes the first answer win.
 */
export class GatewayInteractions {
  private readonly waiters = new Map<string, (response: unknown) => void>();

  constructor(
    private readonly redis: Redis,
    private readonly bus: GatewayBus,
    private readonly db: Kysely<Database>,
    private readonly instanceId: string,
  ) {}

  /** Starts listening for answers routed to this instance. */
  listen(hub: Hub): Promise<unknown> {
    return hub.listen(replyTopic(this.instanceId), (raw) => {
      try {
        const message = JSON.parse(raw) as { interactionId: string; response: unknown };
        this.waiters.get(message.interactionId)?.(message.response);
      } catch {
        // A malformed reply is dropped; the waiter times out.
      }
    });
  }

  async ask(botId: string, payload: InteractionPayload, deadlineMs: number): Promise<AskResult> {
    const connectionId = await this.bus.pick(botId);
    if (!connectionId) return { ok: false, reason: 'unreachable' };

    const key = pendingKey(payload.id);
    await this.redis.set(key, this.instanceId, 'PX', deadlineMs + PENDING_GRACE_MS);
    const answer = new Promise<unknown>((resolve) => this.waiters.set(payload.id, resolve));
    const clean = () => {
      this.waiters.delete(payload.id);
      void this.redis.del(key).catch(() => undefined);
    };
    const delivered = await this.bus
      .publish(connectionId, { type: 'interaction.create', interaction: payload })
      .catch(() => 0);
    if (delivered === 0) {
      clean();
      return { ok: false, reason: 'unreachable' };
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deadlineMs);
    });
    const outcome = await Promise.race([answer, timeout]);
    clearTimeout(timer);
    clean();
    if (outcome === 'timeout') return { ok: false, reason: 'timeout' };
    return { ok: true, response: outcome };
  }

  /** A bot's `interaction.respond` frame: check it, then hand it to the waiting instance. */
  async respond(
    botId: string,
    frame: { interactionId: string; token: string; response: unknown },
  ): Promise<void> {
    const row = await this.db
      .selectFrom('interactions')
      .select(['bot_id', 'token_hash'])
      .where('id', '=', frame.interactionId)
      .executeTakeFirst();
    const valid = verifySecret(frame.token, row?.token_hash ?? DUMMY_HASH);
    if (!row || row.bot_id !== botId || !valid) {
      throw new AppError(403, 'invalid_token', 'Invalid interaction token');
    }
    const instance = await this.redis.getdel(pendingKey(frame.interactionId));
    if (!instance) {
      throw new AppError(
        409,
        'interaction_not_pending',
        'This interaction was already answered or timed out; use the follow-up endpoint',
      );
    }
    await this.redis.publish(
      replyTopic(instance),
      JSON.stringify({ interactionId: frame.interactionId, response: frame.response }),
    );
  }
}
