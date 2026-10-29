import type { PresenceStatus, UserStatus } from '@harmony/shared';

/**
 * What the signed-in user shows to others. The chosen status is stored on `me`; automatic
 * idleness comes from the server (all devices idle) through the presence map, and only applies
 * while the chosen status is online.
 */
export function ownShownStatus(
  chosen: UserStatus,
  live: PresenceStatus | undefined,
): PresenceStatus {
  if (chosen === 'invisible') return 'offline';
  if (chosen === 'online' && live === 'idle') return 'idle';
  return chosen;
}
