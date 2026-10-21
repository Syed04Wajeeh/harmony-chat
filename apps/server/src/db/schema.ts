import type { ColumnType, Generated } from 'kysely';

export interface UsersTable {
  id: Generated<string>;
  login: string;
  display_name: string;
  avatar_url: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface ChannelsTable {
  id: Generated<string>;
  name: string;
  topic: string | null;
  created_by: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface MessagesTable {
  id: Generated<string>;
  channel_id: string;
  author_id: string;
  content: string;
  created_at: ColumnType<Date, string | undefined, never>;
  edited_at: Date | null;
  deleted_at: Date | null;
}

export interface Database {
  users: UsersTable;
  channels: ChannelsTable;
  messages: MessagesTable;
}
