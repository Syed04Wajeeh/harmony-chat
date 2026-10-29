import type { HarmonyApi } from './harmony.ts';

interface Snapshot {
  at: number;
  ownerId: string;
  everyone: Set<string>;
  roles: Map<string, Set<string>>;
  members: Map<string, string[]>;
}

/**
 * Whether a person holds a permission key in the guild, worked out from the roles the bot is
 * allowed to read (`channels.read`). Harmony itself checks `requiredPermission` on every button
 * press; this is the same rule applied again inside the bot, and the only check for slash
 * commands, which Harmony does not gate by key. Fails closed: an unknown person, a failed lookup
 * or a missing key is a refusal. Instance admins who hold no role here are not recognised; give
 * them a role that has the key.
 */
export class PermissionChecker {
  private snapshot: Snapshot | undefined;
  private inflight: Promise<Snapshot> | undefined;

  private readonly api: HarmonyApi;
  private readonly guildId: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(api: HarmonyApi, guildId: string, ttlMs = 10_000, now: () => number = Date.now) {
    this.api = api;
    this.guildId = guildId;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private async load(): Promise<Snapshot> {
    const [guilds, roles, members] = await Promise.all([
      this.api.guilds(),
      this.api.roles(this.guildId),
      this.api.members(this.guildId),
    ]);
    const guild = guilds.find((g) => g.id === this.guildId);
    return {
      at: this.now(),
      ownerId: guild?.ownerId ?? '',
      everyone: new Set(roles.find((r) => r.isDefault)?.permissions ?? []),
      roles: new Map(roles.filter((r) => !r.isDefault).map((r) => [r.id, new Set(r.permissions)])),
      members: new Map(members.map((m) => [m.id, m.roleIds])),
    };
  }

  private async current(): Promise<Snapshot> {
    if (this.snapshot && this.now() - this.snapshot.at < this.ttlMs) return this.snapshot;
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    this.snapshot = await this.inflight;
    return this.snapshot;
  }

  async has(userId: string, permission: string): Promise<boolean> {
    let snap: Snapshot;
    try {
      snap = await this.current();
    } catch {
      return false;
    }
    const roleIds = snap.members.get(userId);
    if (roleIds === undefined) return false; // not a member of the guild
    if (snap.ownerId === userId) return true;
    const keys = new Set(snap.everyone);
    for (const id of roleIds) for (const key of snap.roles.get(id) ?? []) keys.add(key);
    return keys.has('administrator') || keys.has(permission);
  }
}
