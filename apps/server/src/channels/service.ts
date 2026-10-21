import type { Kysely } from 'kysely';
import type { Channel } from '@harmony/shared';
import type { Database } from '../db/schema.js';

export class ChannelService {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<Channel[]> {
    const rows = await this.db.selectFrom('channels').selectAll().orderBy('name').execute();
    return rows.map(({ id, name, topic }) => ({ id, name, topic }));
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('channels')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    return row !== undefined;
  }
}
