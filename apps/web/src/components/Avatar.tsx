import type { PresenceStatus, User } from '@harmony/shared';

const TONES = 7;

function toneFor(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % TONES;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('')
    .toUpperCase() || '?';

export type DotStatus = PresenceStatus | 'invisible';

export function StatusDot({ status, className = '' }: { status: DotStatus; className?: string }) {
  const shown = status === 'invisible' ? 'offline' : status;
  return <span className={`status-dot status-${shown} ${className}`} aria-hidden="true" />;
}

interface AvatarProps {
  user: Pick<User, 'id' | 'displayName' | 'avatarUrl'>;
  size?: number;
  status?: DotStatus;
}

export function Avatar({ user, size = 40, status }: AvatarProps) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" />
      ) : (
        <span className={`avatar-fallback tone-${String(toneFor(user.id))}`}>
          {initialsOf(user.displayName)}
        </span>
      )}
      {status && <StatusDot status={status} className="avatar-status" />}
    </span>
  );
}

interface GuildIconProps {
  guild: { id: string; name: string; iconUrl: string | null };
  size?: number;
}

export function GuildIcon({ guild, size = 48 }: GuildIconProps) {
  return (
    <span className="guild-icon" style={{ width: size, height: size, fontSize: size * 0.34 }}>
      {guild.iconUrl ? (
        <img src={guild.iconUrl} alt="" width={size} height={size} />
      ) : (
        <span className={`avatar-fallback tone-${String(toneFor(guild.id))}`}>
          {initialsOf(guild.name)}
        </span>
      )}
    </span>
  );
}
