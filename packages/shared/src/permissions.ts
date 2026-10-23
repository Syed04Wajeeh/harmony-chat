import { z } from 'zod';
import { DirectoryUser, Id, PresenceStatus } from './chat.js';

export type PermissionCategory = 'general' | 'text' | 'members' | 'management';

export interface CorePermission {
  key: string;
  category: PermissionCategory;
  description: string;
  /** Channel overwrites may allow or deny it; the rest only make sense guild-wide. */
  channel: boolean;
}

export const CORE_PERMISSIONS: readonly CorePermission[] = [
  {
    key: 'view_channel',
    category: 'general',
    channel: true,
    description: 'See the channel and read its history',
  },
  {
    key: 'send_messages',
    category: 'text',
    channel: true,
    description: 'Send messages and show typing',
  },
  { key: 'attach_files', category: 'text', channel: true, description: 'Upload files and images' },
  {
    key: 'add_reactions',
    category: 'text',
    channel: true,
    description: 'Add reactions to messages',
  },
  { key: 'use_commands', category: 'text', channel: true, description: 'Run slash commands' },
  {
    key: 'mention_everyone',
    category: 'text',
    channel: true,
    description: 'Mention everyone (reserved: no mass mention exists yet)',
  },
  {
    key: 'manage_messages',
    category: 'text',
    channel: true,
    description: "Delete other people's messages and pin messages",
  },
  {
    key: 'create_channels',
    category: 'management',
    channel: false,
    description: 'Create channels',
  },
  {
    key: 'manage_channels',
    category: 'management',
    channel: true,
    description: 'Edit and archive any channel, and manage who is in a private channel',
  },
  {
    key: 'manage_roles',
    category: 'management',
    channel: true,
    description: 'Create roles, edit roles below your own, assign them and set channel overwrites',
  },
  {
    key: 'manage_guild',
    category: 'management',
    channel: false,
    description: 'Rename the server, change its icon, and manage modules, bots and webhooks',
  },
  {
    key: 'manage_emoji',
    category: 'management',
    channel: false,
    description: 'Upload, rename and delete the custom emoji of the server',
  },
  { key: 'create_invites', category: 'management', channel: false, description: 'Create invites' },
  {
    key: 'kick_members',
    category: 'members',
    channel: false,
    description: 'Remove members who rank below you',
  },
  {
    key: 'manage_nicknames',
    category: 'members',
    channel: false,
    description: "Change other members' nicknames",
  },
  {
    key: 'change_nickname',
    category: 'members',
    channel: false,
    description: 'Change your own nickname',
  },
  {
    key: 'administrator',
    category: 'management',
    channel: false,
    description: 'Every permission, and channel overwrites do not apply',
  },
];

export const CORE_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  CORE_PERMISSIONS.map((permission) => permission.key),
);

/** What @everyone gets in a new guild; the same set the migration gave existing guilds. */
export const DEFAULT_EVERYONE_PERMISSIONS: readonly string[] = [
  'view_channel',
  'send_messages',
  'attach_files',
  'add_reactions',
  'use_commands',
  'create_channels',
  'create_invites',
  'change_nickname',
  'pins.pin',
  'polls.create',
  'polls.vote',
];

export const MAX_ROLE_NAME_LENGTH = 100;
export const MAX_NICKNAME_LENGTH = 32;

/** `view_channel` for core keys, `polls.create` for a module's. */
export const PermissionKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9_]*)?$/)
  .max(64);
const PermissionList = z.array(PermissionKey).max(200);
const RoleColor = z.number().int().min(0).max(0xffffff);
const RoleName = z.string().trim().min(1).max(MAX_ROLE_NAME_LENGTH);

export const Role = z.object({
  id: Id,
  guildId: Id,
  name: z.string(),
  color: RoleColor.nullable(),
  /** Higher outranks lower. The @everyone role is always 0. */
  position: z.number().int().min(0),
  hoist: z.boolean(),
  mentionable: z.boolean(),
  permissions: z.array(z.string()),
  isDefault: z.boolean(),
});
export type Role = z.infer<typeof Role>;
export const ListRolesResponse = z.object({ roles: z.array(Role) });

export const RoleParams = z.object({ id: Id, roleId: Id });
export const MemberRoleParams = z.object({ id: Id, userId: Id, roleId: Id });
export const GuildMemberParams = z.object({ id: Id, userId: Id });

export const CreateRoleBody = z.object({
  name: RoleName,
  color: RoleColor.nullable().optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  permissions: PermissionList.optional(),
});
export type CreateRoleBody = z.infer<typeof CreateRoleBody>;

export const UpdateRoleBody = z
  .object({
    name: RoleName.optional(),
    color: RoleColor.nullable().optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    permissions: PermissionList.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateRoleBody = z.infer<typeof UpdateRoleBody>;

/** Every role except @everyone, highest first. */
export const ReorderRolesBody = z.object({ roleIds: z.array(Id).max(250) });
export type ReorderRolesBody = z.infer<typeof ReorderRolesBody>;

export const OverwriteTarget = z.enum(['role', 'member']);
export type OverwriteTarget = z.infer<typeof OverwriteTarget>;

export const ChannelOverwrite = z.object({
  channelId: Id,
  targetType: OverwriteTarget,
  targetId: Id,
  allow: z.array(z.string()),
  deny: z.array(z.string()),
});
export type ChannelOverwrite = z.infer<typeof ChannelOverwrite>;
export const ListOverwritesResponse = z.object({ overwrites: z.array(ChannelOverwrite) });

export const OverwriteParams = z.object({ id: Id, targetType: OverwriteTarget, targetId: Id });
export const PutOverwriteBody = z.object({
  allow: PermissionList.default([]),
  deny: PermissionList.default([]),
});
export type PutOverwriteBody = z.input<typeof PutOverwriteBody>;

export const EffectivePermissions = z.object({
  /** Every key the caller holds; the full list for owners, administrators and instance admins. */
  permissions: z.array(z.string()),
  /** True when nothing can be denied: owner, instance admin or the `administrator` permission. */
  administrator: z.boolean(),
  isOwner: z.boolean(),
  /** Position of the caller's highest role, for hiding controls that hierarchy would refuse. */
  topPosition: z.number().int(),
});
export type EffectivePermissions = z.infer<typeof EffectivePermissions>;
export const EffectivePermissionsQuery = z.object({ channelId: Id.optional() });

export const GuildMember = DirectoryUser.extend({
  status: PresenceStatus,
  joinedAt: z.iso.datetime(),
  roleIds: z.array(Id),
  nickname: z.string().nullable(),
  /** Color of the highest role that has one. */
  topRoleColor: RoleColor.nullable(),
});
export type GuildMember = z.infer<typeof GuildMember>;
export const GuildMembersResponse = z.object({ members: z.array(GuildMember) });

export const NicknameBody = z.object({
  nickname: z.string().trim().min(1).max(MAX_NICKNAME_LENGTH).nullable(),
});
export const TransferGuildBody = z.object({ userId: Id });

/** A role as the resolution below sees it. */
export interface RoleGrant {
  id: string;
  position: number;
  permissions: readonly string[];
}

export interface OverwriteRule {
  targetType: OverwriteTarget;
  targetId: string;
  allow: readonly string[];
  deny: readonly string[];
}

export interface PermissionInput {
  userId: string;
  isOwner: boolean;
  isInstanceAdmin: boolean;
  /** The guild's default role. */
  everyone: RoleGrant;
  /** The member's own roles, without @everyone. */
  roles: readonly RoleGrant[];
  /** The channel's overwrites; omit for guild-wide permissions. */
  overwrites?: readonly OverwriteRule[] | undefined;
}

/** `all` means nothing can be denied, so `keys` is not consulted. */
export interface Permissions {
  all: boolean;
  keys: ReadonlySet<string>;
}

const EVERYTHING: Permissions = { all: true, keys: new Set() };

export const hasPermission = (permissions: Permissions, key: string): boolean =>
  permissions.all || permissions.keys.has(key);

/**
 * Resolves what a member may do, in this order:
 * 1. The owner and instance admins can do everything.
 * 2. The union of the permissions of @everyone and the member's roles; `administrator` means
 *    everything, and overwrites are skipped.
 * 3. Channel overwrites: @everyone's, then all of the member's roles' denies and then their
 *    allows, then the member's own deny and allow.
 */
export function computePermissions(input: PermissionInput): Permissions {
  if (input.isOwner || input.isInstanceAdmin) return EVERYTHING;

  const keys = new Set(input.everyone.permissions);
  for (const role of input.roles) for (const key of role.permissions) keys.add(key);
  if (keys.has('administrator')) return EVERYTHING;

  const rules = input.overwrites ?? [];
  const apply = (matching: readonly OverwriteRule[]) => {
    for (const rule of matching) for (const key of rule.deny) keys.delete(key);
    for (const rule of matching) for (const key of rule.allow) keys.add(key);
  };
  const forRole = (id: string) =>
    rules.filter((rule) => rule.targetType === 'role' && rule.targetId === id);

  apply(forRole(input.everyone.id));

  const own = input.roles.flatMap((role) => forRole(role.id));
  for (const rule of own) for (const key of rule.deny) keys.delete(key);
  for (const rule of own) for (const key of rule.allow) keys.add(key);

  apply(rules.filter((rule) => rule.targetType === 'member' && rule.targetId === input.userId));
  return { all: false, keys };
}

/** Highest position among the member's roles; 0 (@everyone) when they have none. */
export const topPosition = (roles: readonly { position: number }[]): number =>
  roles.reduce((top, role) => Math.max(top, role.position), 0);

export interface Rank {
  /** Owners and instance admins outrank everyone and are exempt from hierarchy. */
  superuser: boolean;
  top: number;
}

/** Whether `actor` may act on something at `position` (a role, or another member's top role). */
export const outranks = (actor: Rank, position: number): boolean =>
  actor.superuser || actor.top > position;

/** You can only hand out permissions you hold yourself. */
export function missingToGrant(actor: Permissions, wanted: readonly string[]): string[] {
  return actor.all ? [] : wanted.filter((key) => !actor.keys.has(key));
}

/** The keys an `all` holder has, for APIs that list permissions explicitly. */
export function expand(permissions: Permissions, everyKey: Iterable<string>): string[] {
  return permissions.all ? [...everyKey] : [...permissions.keys];
}
export type NicknameBody = z.infer<typeof NicknameBody>;
