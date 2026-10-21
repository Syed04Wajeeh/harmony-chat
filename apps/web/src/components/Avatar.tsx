import type { User } from '@harmony/shared';

const PALETTE = ['#5865f2', '#3ba55d', '#faa61a', '#eb459e', '#ed4245', '#1abc9c', '#9b59b6'];

function colorFor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? PALETTE[0]!;
}

export function Avatar({ user, size = 40 }: { user: User; size?: number }) {
  const style = { width: size, height: size, fontSize: size * 0.45 };
  if (user.avatarUrl) {
    return (
      <img
        className="avatar"
        style={style}
        src={user.avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span className="avatar" style={{ ...style, background: colorFor(user.login) }} aria-hidden>
      {Array.from(user.displayName)[0]?.toUpperCase() ?? '?'}
    </span>
  );
}
