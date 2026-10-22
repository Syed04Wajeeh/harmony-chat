import {
  CORE_PERMISSIONS,
  type GuildModule,
  type PermissionCategory,
  type PermissionDefinition,
} from '@harmony/shared';

export interface PermissionGroup {
  title: string;
  items: readonly PermissionDefinition[];
}

const CATEGORY_TITLES: Record<PermissionCategory, string> = {
  general: 'General',
  text: 'Messages',
  members: 'Members',
  management: 'Server management',
};

/** Core permissions by category, then one group per module that defines any. */
export function permissionGroups(
  modules: readonly GuildModule[],
  { channelOnly = false }: { channelOnly?: boolean } = {},
): PermissionGroup[] {
  const groups: PermissionGroup[] = (Object.keys(CATEGORY_TITLES) as PermissionCategory[]).map(
    (category) => ({
      title: CATEGORY_TITLES[category],
      items: CORE_PERMISSIONS.filter(
        (permission) => permission.category === category && (!channelOnly || permission.channel),
      ),
    }),
  );
  for (const module of modules) {
    if (module.permissions.length > 0)
      groups.push({ title: module.name, items: module.permissions });
  }
  return groups.filter((group) => group.items.length > 0);
}

/** `manage_messages` to "Manage messages". */
export const permissionLabel = (key: string): string => {
  const name = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
  const text = name.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
