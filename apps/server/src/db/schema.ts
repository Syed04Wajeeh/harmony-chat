import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, string | undefined, never>;

export interface UsersTable {
  id: Generated<string>;
  login: string;
  display_name: string;
  avatar_url: string | null;
  is_admin: Generated<boolean>;
  status: Generated<string>;
  created_at: Timestamp;
}

export interface GuildsTable {
  id: Generated<string>;
  name: string;
  icon_attachment_id: string | null;
  owner_id: string;
  is_default: Generated<boolean>;
  created_at: Timestamp;
}

export interface GuildMembersTable {
  guild_id: string;
  user_id: string;
  joined_at: Timestamp;
}

export interface GuildInvitesTable {
  code: string;
  guild_id: string;
  created_by: string;
  expires_at: Date | null;
  max_uses: number | null;
  uses: Generated<number>;
  created_at: Timestamp;
}

export interface ChannelsTable {
  id: Generated<string>;
  guild_id: string | null;
  kind: Generated<string>;
  name: string | null;
  topic: string | null;
  is_private: Generated<boolean>;
  dm_key: string | null;
  created_by: string | null;
  created_at: Timestamp;
  archived_at: Date | null;
}

export interface ChannelMembersTable {
  channel_id: string;
  user_id: string;
  joined_at: Timestamp;
  last_read_message_id: string | null;
}

export interface MessagesTable {
  id: Generated<string>;
  channel_id: string;
  author_id: string;
  content: string;
  created_at: Timestamp;
  edited_at: Date | null;
  deleted_at: Date | null;
  reply_to_id: string | null;
  pinned_at: Date | null;
  pinned_by: string | null;
  search: ColumnType<string, never, never>;
}

export interface MessageReactionsTable {
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: Timestamp;
}

export interface MessageMentionsTable {
  message_id: string;
  user_id: string;
}

export interface AttachmentsTable {
  id: Generated<string>;
  uploader_id: string;
  message_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: ColumnType<string, number, never>;
  sha256: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  created_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  guilds: GuildsTable;
  guild_members: GuildMembersTable;
  guild_invites: GuildInvitesTable;
  channels: ChannelsTable;
  channel_members: ChannelMembersTable;
  messages: MessagesTable;
  message_reactions: MessageReactionsTable;
  message_mentions: MessageMentionsTable;
  attachments: AttachmentsTable;
}
