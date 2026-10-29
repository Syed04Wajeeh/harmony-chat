import { createHash } from 'node:crypto';
import { BotError, clean } from './errors.ts';
import type { Verb } from './docker.ts';
import type { GameServer } from './pterodactyl.ts';

/** "Core Keeper (EU)" becomes `core_keeper_eu`. */
export const slugify = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export type Target =
  | { kind: 'docker'; name: string; slug: string; control: boolean }
  | { kind: 'game'; name: string; slug: string; id: string; control: true };

export const targetKey = (target: Target): string =>
  target.kind === 'docker' ? `docker:${target.name}` : `game:${target.id}`;

/** Control verbs and the button-id prefix of each (button ids are at most 32 characters). */
const PREFIX: Record<Verb, string> = { restart: 'rs', stop: 'sp', start: 'st' };
const MAX_SLUG_IN_ID = 28;

/** The part of a button id that names the target; long names are cut and given a short hash. */
function idPart(slug: string): string {
  const dashed = slug.replace(/_/g, '-');
  if (dashed.length <= MAX_SLUG_IN_ID) return dashed;
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 7);
  return `${dashed.slice(0, MAX_SLUG_IN_ID - 8).replace(/-+$/, '')}-${hash}`;
}

export const buttonId = (verb: Verb, target: Target): string =>
  `${PREFIX[verb]}-${idPart(target.kind === 'game' ? `g-${target.slug}` : target.slug)}`;

/**
 * Everything the bot is allowed to touch right now: the allowlisted containers (control and
 * status-only) and the game servers Pterodactyl reports. Button ids and command arguments are
 * looked up here and nowhere else, so an id that was never produced by `buttonId` for a
 * controllable target finds nothing.
 */
export class Registry {
  readonly targets: Target[];
  private readonly byButton = new Map<string, { verb: Verb; target: Target }>();

  constructor(
    docker: { control: readonly string[]; status: readonly string[] },
    games: readonly GameServer[],
    gameAllow: readonly string[] = [],
  ) {
    const targets: Target[] = [
      ...docker.control.map((name) => ({
        kind: 'docker' as const,
        name,
        slug: slugify(name),
        control: true,
      })),
      ...docker.status.map((name) => ({
        kind: 'docker' as const,
        name,
        slug: slugify(name),
        control: false,
      })),
    ];
    const counts = new Map<string, number>();
    for (const game of games)
      counts.set(slugify(game.name), (counts.get(slugify(game.name)) ?? 0) + 1);
    for (const game of games) {
      if (game.suspended) continue;
      const slug = slugify(game.name);
      if (!slug || (gameAllow.length > 0 && !gameAllow.includes(slug))) continue;
      // Two servers with one name would make `/restart name` ambiguous, so neither is offered.
      if ((counts.get(slug) ?? 0) > 1) continue;
      targets.push({ kind: 'game', name: game.name, slug, id: game.id, control: true });
    }
    this.targets = targets;
    for (const target of targets) {
      if (!target.control) continue;
      for (const verb of ['start', 'stop', 'restart'] as const) {
        const id = buttonId(verb, target);
        if (this.byButton.has(id)) throw new Error(`Two targets share the button id ${id}`);
        this.byButton.set(id, { verb, target });
      }
    }
  }

  get controllable(): Target[] {
    return this.targets.filter((t) => t.control);
  }

  get games(): Extract<Target, { kind: 'game' }>[] {
    return this.targets.filter((t): t is Extract<Target, { kind: 'game' }> => t.kind === 'game');
  }

  /** A forged or stale id, or one for a status-only container, returns undefined. */
  fromButton(id: string): { verb: Verb; target: Target } | undefined {
    return this.byButton.get(id);
  }

  /**
   * Resolves what a person typed. A container name matches exactly (any case); otherwise the
   * slug is compared, so `core-keeper`, `core_keeper` and `Core Keeper` all find the game server
   * called "Core Keeper". `game:` and `docker:` prefixes disambiguate. Status-only containers
   * resolve (so the answer can say they are read-only) but `control` is false.
   */
  resolve(input: string): Target {
    const raw = clean(input, 80).toLowerCase();
    let wanted = raw;
    let kind: Target['kind'] | undefined;
    if (raw.startsWith('game:')) [kind, wanted] = ['game', raw.slice(5).trim()];
    else if (raw.startsWith('docker:')) [kind, wanted] = ['docker', raw.slice(7).trim()];
    const slug = slugify(wanted);
    const pool = this.targets.filter((t) => !kind || t.kind === kind);
    const exact = pool.filter((t) => t.name.toLowerCase() === wanted);
    const found = exact.length > 0 ? exact : slug ? pool.filter((t) => t.slug === slug) : [];
    if (found.length === 1 && found[0]) return found[0];
    if (found.length > 1) {
      throw new BotError(
        'not_found',
        `"${clean(input, 40)}" matches more than one target; prefix it with game: or docker:.`,
      );
    }
    throw new BotError(
      'not_found',
      `"${clean(input, 40)}" is not a target. Try /status to see the list.`,
    );
  }

  /** What a person may type, for error messages. */
  names(controllableOnly = true): string[] {
    return (controllableOnly ? this.controllable : this.targets).map((t) =>
      t.kind === 'game' ? t.slug : t.name,
    );
  }
}

/** Refuses a second action on the same target within a window (double clicks, retries). */
export class Cooldown {
  private readonly until = new Map<string, number>();

  private readonly ms: number;
  private readonly now: () => number;

  constructor(ms: number, now: () => number = Date.now) {
    this.ms = ms;
    this.now = now;
  }

  /** Starts the window, or throws with how long is left. */
  claim(key: string): void {
    const now = this.now();
    const until = this.until.get(key) ?? 0;
    if (until > now) {
      const left = Math.ceil((until - now) / 1000);
      throw new BotError(
        'cooldown',
        `Hold on, that was just done; try again in ${String(left)} s.`,
      );
    }
    this.until.set(key, now + this.ms);
    // Forget old entries so the map cannot grow without bound.
    for (const [k, t] of this.until) if (t <= now) this.until.delete(k);
  }

  /** A failed action does not keep the target locked. */
  release(key: string): void {
    this.until.delete(key);
  }
}
