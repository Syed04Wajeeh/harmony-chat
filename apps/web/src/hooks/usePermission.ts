import { useEffect } from 'react';
import type { Message, Role } from '@harmony/shared';
import { loadPermissions } from '../store/actions.js';
import { useApp, type AppState } from '../store/store.js';

/**
 * Whether the signed-in user holds a permission in a guild, or in one of its channels. Only used
 * to hide controls; the server decides. Loads the answer on first use and unknown means hidden.
 */
export function usePermission(
  guildId: string | null | undefined,
  key: string,
  channelId?: string,
): boolean {
  const loaded = useApp((state) =>
    channelId
      ? state.channelPermissions[channelId]
      : guildId
        ? state.guildPermissions[guildId]
        : undefined,
  );
  useEffect(() => {
    if (guildId && !loaded) void loadPermissions(guildId, channelId);
  }, [guildId, channelId, loaded]);
  return loaded ? loaded.administrator || loaded.permissions.includes(key) : false;
}

/** Highest role position the user holds in a guild, for hierarchy-aware controls. */
export function useTopPosition(guildId: string): { top: number; superuser: boolean } {
  const permissions = useApp((state) => state.guildPermissions[guildId]);
  return { top: permissions?.topPosition ?? 0, superuser: permissions?.administrator ?? false };
}

/** The color of a member's highest colored role, or null. */
export function memberColor(
  state: AppState,
  guildId: string | null,
  userId: string,
): number | null {
  if (!guildId) return null;
  const roleIds = state.memberInfo[guildId]?.[userId]?.roleIds;
  const roles = state.roles[guildId];
  if (!roleIds || !roles) return null;
  const held = roles.filter((role: Role) => roleIds.includes(role.id) && role.color !== null);
  return held[0]?.color ?? null;
}

/** Authors delete their own messages; `manage_messages` (or the admin override in DMs) any. */
export function useCanDelete(message: Message): boolean {
  const meId = useApp((state) => state.me?.id);
  const isAdmin = useApp((state) => state.me?.isAdmin ?? false);
  const guildId = useApp((state) => state.channels[message.channelId]?.guildId ?? null);
  const moderator = usePermission(guildId, 'manage_messages', message.channelId);
  return message.author.id === meId || moderator || (guildId === null && isAdmin);
}

/** All of the signed-in user's permissions in a guild at once; `loaded` is false until known. */
export function useGuildAccess(guildId: string, channelId?: string) {
  const loaded = useApp((state) =>
    channelId ? state.channelPermissions[channelId] : state.guildPermissions[guildId],
  );
  const isOwner = useApp((state) => state.guilds[guildId]?.ownerId === state.me?.id);
  useEffect(() => {
    if (guildId && !loaded) void loadPermissions(guildId, channelId);
  }, [guildId, channelId, loaded]);
  return {
    loaded: loaded !== undefined,
    isOwner,
    top: loaded?.topPosition ?? 0,
    superuser: loaded?.administrator ?? false,
    has: (key: string) =>
      loaded !== undefined && (loaded.administrator || loaded.permissions.includes(key)),
  };
}
