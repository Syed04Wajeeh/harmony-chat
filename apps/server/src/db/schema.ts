import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, string | undefined, never>;

export interface UsersTable {
  id: Generated<string>;
  login: string;
  display_name: string;
  avatar_url: string | null;
  provider_avatar_url: Generated<string | null>;
  avatar_overridden: Generated<boolean>;
  is_admin: Generated<boolean>;
  status: Generated<string>;
  kind: Generated<'human' | 'bot'>;
  bot_owner_id: Generated<string | null>;
  created_at: Timestamp;
}

export interface GuildsTable {
  id: Generated<string>;
  name: string;
  icon_attachment_id: string | null;
  accent_color: Generated<number | null>;
  banner_attachment_id: Generated<string | null>;
  description: Generated<string | null>;
  owner_id: string;
  is_default: Generated<boolean>;
  created_at: Timestamp;
}

export interface GuildMembersTable {
  guild_id: string;
  user_id: string;
  joined_at: Timestamp;
  nickname: Generated<string | null>;
}

export interface RolesTable {
  id: Generated<string>;
  guild_id: string;
  name: string;
  color: number | null;
  position: number;
  hoist: Generated<boolean>;
  mentionable: Generated<boolean>;
  permissions: Generated<string[]>;
  is_default: Generated<boolean>;
  created_at: Timestamp;
}

export interface MemberRolesTable {
  guild_id: string;
  user_id: string;
  role_id: string;
}

export interface ChannelOverwritesTable {
  channel_id: string;
  target_type: 'role' | 'member';
  target_id: string;
  allow: Generated<string[]>;
  deny: Generated<string[]>;
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
  bot_feed: Generated<boolean>;
}

export interface ChannelBotsTable {
  channel_id: string;
  bot_id: string;
  position: Generated<number>;
  created_at: Generated<Date>;
}

export interface BotSchedulesTable {
  id: Generated<string>;
  bot_id: string;
  slug: string;
  guild_id: string;
  channel_id: string;
  every_seconds: number | null;
  cron: string | null;
  panel_key: string | null;
  paused: Generated<boolean>;
  next_run_at: Date;
  pending_until: Date | null;
  last_run_at: Date | null;
  last_status: 'ok' | 'failed' | 'skipped' | null;
  last_error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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
  webhook_id: Generated<string | null>;
  display_name_override: Generated<string | null>;
  avatar_url_override: Generated<string | null>;
  embeds: Generated<unknown>;
  components: Generated<unknown>;
  modules: Generated<string[]>;
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

export interface BotsTable {
  user_id: string;
  token_hash: Buffer;
  signing_secret: string;
  scopes: string[];
  interactions_url: string | null;
  events_url: string | null;
  event_types: string[];
  /** Last gateway event number handed out to this bot. */
  event_seq: Generated<string>;
  created_at: Timestamp;
  token_rotated_at: Generated<Date>;
  last_used_at: Date | null;
}

export interface WebhooksTable {
  id: Generated<string>;
  channel_id: string;
  name: string;
  avatar_attachment_id: string | null;
  token_hash: Buffer;
  user_id: string;
  created_by: string;
  created_at: Timestamp;
  format: Generated<string>;
  template: ColumnType<unknown, string | null, string | null>;
  signature_secret: string | null;
}

export interface BotCommandsTable {
  id: Generated<string>;
  bot_id: string;
  guild_id: string;
  name: string;
  description: string;
  options: ColumnType<unknown, string, string>;
  created_at: Timestamp;
}

export interface InteractionsTable {
  id: Generated<string>;
  token_hash: Buffer;
  bot_id: string;
  user_id: string;
  channel_id: string;
  command_name: string;
  options: ColumnType<unknown, string, string>;
  nonce: string | null;
  created_at: Timestamp;
  expires_at: Date;
  type: Generated<'command' | 'action' | 'refresh'>;
  action_id: Generated<string | null>;
  panel_id: Generated<string | null>;
  message_id: Generated<string | null>;
}

export interface PanelsTable {
  id: Generated<string>;
  channel_id: string;
  bot_id: string;
  key: string;
  view: ColumnType<unknown, string, string>;
  version: Generated<number>;
  pinned: Generated<boolean>;
  position: Generated<number>;
  created_at: Timestamp;
  updated_at: Generated<Date>;
}

export interface EventOutboxTable {
  id: Generated<string>;
  guild_id: string;
  channel_id: string | null;
  type: string;
  payload: unknown;
  created_at: Timestamp;
  fanned_out_at: Date | null;
}

export interface EventDeliveriesTable {
  id: Generated<string>;
  event_id: string;
  bot_id: string;
  status: Generated<string>;
  attempts: Generated<number>;
  next_attempt_at: Generated<Date>;
  last_status_code: number | null;
  last_error: string | null;
  /** Per-bot sequence number for gateway deliveries; null for HTTP ones. */
  seq: string | null;
  created_at: Timestamp;
  delivered_at: Date | null;
}

export interface GuildModulesTable {
  guild_id: string;
  module_id: string;
  enabled: Generated<boolean>;
  settings: ColumnType<Record<string, unknown>, string | undefined, string>;
  updated_at: Generated<Date>;
}

export interface UserSettingsTable {
  user_id: string;
  appearance: ColumnType<Record<string, unknown>, string | undefined, string>;
  behavior: ColumnType<Record<string, unknown>, string | undefined, string>;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface UserThemesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  base: 'dark' | 'light';
  tokens: ColumnType<Record<string, string>, string, string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UserProfilesTable {
  user_id: string;
  avatar_attachment_id: string | null;
  banner_attachment_id: string | null;
  banner_color: number | null;
  accent_color: number | null;
  bio: string | null;
  pronouns: string | null;
  status_emoji: string | null;
  status_text: string | null;
  status_expires_at: Date | null;
  updated_at: Generated<Date>;
}

export interface GuildEmojiTable {
  id: Generated<string>;
  guild_id: string;
  name: string;
  attachment_id: string;
  animated: boolean;
  created_by: string | null;
  created_at: Timestamp;
}

export interface UserPerksTable {
  user_id: string;
  perk: string;
  granted_by: string | null;
  granted_at: Generated<Date>;
}

export interface Database {
  user_profiles: UserProfilesTable;
  guild_emoji: GuildEmojiTable;
  user_perks: UserPerksTable;
  users: UsersTable;
  guilds: GuildsTable;
  guild_members: GuildMembersTable;
  roles: RolesTable;
  member_roles: MemberRolesTable;
  channel_overwrites: ChannelOverwritesTable;
  guild_invites: GuildInvitesTable;
  channels: ChannelsTable;
  channel_members: ChannelMembersTable;
  channel_bots: ChannelBotsTable;
  bot_schedules: BotSchedulesTable;
  messages: MessagesTable;
  message_reactions: MessageReactionsTable;
  message_mentions: MessageMentionsTable;
  attachments: AttachmentsTable;
  bots: BotsTable;
  webhooks: WebhooksTable;
  bot_commands: BotCommandsTable;
  interactions: InteractionsTable;
  panels: PanelsTable;
  event_outbox: EventOutboxTable;
  event_deliveries: EventDeliveriesTable;
  guild_modules: GuildModulesTable;
  user_settings: UserSettingsTable;
  user_themes: UserThemesTable;
}
