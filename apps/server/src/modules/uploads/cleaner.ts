import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import type { Storage } from '../../uploads/storage.js';

const LOCK_KEY = 'harmony:lock:upload-cleanup';
const BATCH = 500;

export interface CleanerOptions {
  orphanTtlMs: number;
  intervalMs: number;
  instanceId: string;
  /** Instances sharing a key take turns; tests use their own key to run in parallel. */
  lockKey?: string;
}

export interface CleanerLogger {
  warn(obj: object, msg: string): void;
}

/** Deletes uploads that never got attached to a message or used as an icon, banner, avatar or emoji. */
export class UploadCleaner {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly storage: Storage,
    private readonly options: CleanerOptions,
    private readonly log: CleanerLogger,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.runOnce().catch((err: unknown) => this.log.warn({ err }, 'upload cleanup failed'));
    }, this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Runs one pass unless another instance holds the lock, in which case it returns null. The
   * lock expires on its own after half an interval, so across N instances roughly one pass
   * runs per interval and a crashed holder never blocks the next one.
   */
  async runOnce(): Promise<number | null> {
    const lockMs = Math.max(1000, Math.floor(this.options.intervalMs / 2));
    const lockKey = this.options.lockKey ?? LOCK_KEY;
    const acquired = await this.redis.set(lockKey, this.options.instanceId, 'PX', lockMs, 'NX');
    if (acquired !== 'OK') return null;

    let total = 0;
    for (;;) {
      // Rows go first so nothing can serve a record whose file is gone; a crash before the
      // file delete only leaves a stray file behind.
      const rows = await this.db
        .deleteFrom('attachments')
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('attachments')
            .select('id')
            .where('message_id', 'is', null)
            .where((nested) =>
              nested.not(
                nested.exists(
                  nested
                    .selectFrom('guilds')
                    .select('guilds.id')
                    .where((eb) =>
                      eb.or([
                        eb('guilds.icon_attachment_id', '=', eb.ref('attachments.id')),
                        eb('guilds.banner_attachment_id', '=', eb.ref('attachments.id')),
                      ]),
                    ),
                ),
              ),
            )
            .where((nested) =>
              nested.not(
                nested.exists(
                  nested
                    .selectFrom('webhooks')
                    .select('webhooks.id')
                    .whereRef('webhooks.avatar_attachment_id', '=', 'attachments.id'),
                ),
              ),
            )
            .where((nested) =>
              nested.not(
                nested.exists(
                  nested
                    .selectFrom('user_profiles')
                    .select('user_profiles.user_id')
                    .where((eb) =>
                      eb.or([
                        eb('user_profiles.avatar_attachment_id', '=', eb.ref('attachments.id')),
                        eb('user_profiles.banner_attachment_id', '=', eb.ref('attachments.id')),
                      ]),
                    ),
                ),
              ),
            )
            .where((nested) =>
              nested.not(
                nested.exists(
                  nested
                    .selectFrom('guild_emoji')
                    .select('guild_emoji.id')
                    .whereRef('guild_emoji.attachment_id', '=', 'attachments.id'),
                ),
              ),
            )
            .where(
              sql<boolean>`created_at < now() - ${this.options.orphanTtlMs} * interval '1 millisecond'`,
            )
            .limit(BATCH)
            .forUpdate()
            .skipLocked(),
        )
        .where('message_id', 'is', null)
        .returning('storage_key')
        .execute();
      await Promise.all(
        rows.map((row) =>
          this.storage.delete(row.storage_key).catch((err: unknown) => {
            this.log.warn({ err, key: row.storage_key }, 'could not delete orphaned file');
          }),
        ),
      );
      total += rows.length;
      if (rows.length < BATCH) return total;
    }
  }
}
