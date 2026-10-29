import type { Block, Button, PanelView } from '@harmony/shared';
import { isRunning, type ContainerInfo, type Verb } from './docker.ts';
import type { Monitor } from './kuma.ts';
import type { GameResources } from './pterodactyl.ts';
import { buttonId, type Target } from './targets.ts';

/** The limits of the panels API that the builders stay inside (see PANEL_LIMITS in @harmony/shared). */
const MAX_BLOCKS = 24;
const MAX_STATUS_ITEMS = 50;
const MAX_BUTTONS = 5;

type ItemState = 'ok' | 'warn' | 'bad' | 'unknown' | 'off';
type Item = { label: string; state: ItemState; detail?: string };

export const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
};

const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

export function containerItem(info: ContainerInfo | undefined, name: string): Item {
  if (!info) return { label: name, state: 'unknown', detail: 'not found' };
  let state: ItemState;
  if (info.state === 'running')
    state = info.health === 'unhealthy' ? 'bad' : info.health === 'starting' ? 'warn' : 'ok';
  else if (info.state === 'restarting' || info.state === 'paused') state = 'warn';
  else if (info.state === 'created') state = 'off';
  else state = 'bad';
  const detail = info.statusText || info.state;
  return { label: name, state, detail: detail.slice(0, 200) };
}

const toneFor = (bad: number, warn: number) => (bad > 0 ? 'bad' : warn > 0 ? 'warn' : 'good');

/** One status block per 50 items; the API allows no more in one. */
function statusBlocks(title: string, items: Item[], id: string): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < items.length; i += MAX_STATUS_ITEMS) {
    blocks.push({
      type: 'status',
      id: i === 0 ? id : `${id}-${String(i / MAX_STATUS_ITEMS + 1)}`,
      title: i === 0 ? title : `${title} (continued)`,
      items: items.slice(i, i + MAX_STATUS_ITEMS),
    });
  }
  return blocks;
}

const stamp = (now: Date): Block => ({
  type: 'markdown',
  id: 'updated',
  // Minute precision: the panel is rewritten at most once a minute for the clock alone.
  text: `Updated ${now.toISOString().slice(11, 16)} UTC`,
});

function button(verb: Verb, target: Target, permission: string): Button {
  const word = verb === 'restart' ? 'Restart' : verb === 'stop' ? 'Stop' : 'Start';
  return {
    id: buttonId(verb, target),
    label: `${word} ${target.name}`.slice(0, 40),
    style: verb === 'start' ? 'secondary' : verb === 'stop' ? 'danger' : 'primary',
    confirm: {
      title: `${word} ${target.name}?`.slice(0, 100),
      body:
        verb === 'start'
          ? 'It will be started now.'
          : verb === 'stop'
            ? 'It will be stopped and stay stopped until someone starts it.'
            : 'It will be restarted now and may be unavailable for a moment.',
      confirmLabel: word,
    },
    requiredPermission: permission,
  };
}

/** Which buttons make sense for a state: a stopped thing offers Start, a running one Restart and Stop. */
export function verbsFor(state: string): Verb[] {
  if (state === 'running') return ['restart', 'stop'];
  if (['exited', 'created', 'dead', 'offline'].includes(state)) return ['start'];
  if (['starting', 'stopping', 'removing'].includes(state)) return [];
  return ['restart', 'stop'];
}

/** Packs the buttons of consecutive targets into blocks of at most five buttons. */
function actionBlocks(groups: Button[][], idPrefix: string): Block[] {
  const blocks: Block[] = [];
  let current: Button[] = [];
  for (const group of groups) {
    if (current.length > 0 && current.length + group.length > MAX_BUTTONS) {
      blocks.push({
        type: 'actions',
        id: `${idPrefix}-${String(blocks.length + 1)}`,
        buttons: current,
      });
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) {
    blocks.push({
      type: 'actions',
      id: `${idPrefix}-${String(blocks.length + 1)}`,
      buttons: current,
    });
  }
  return blocks;
}

export interface ContainersInput {
  control: readonly Target[];
  status: readonly Target[];
  infos: ReadonlyMap<string, ContainerInfo>;
  permission: string;
  now: Date;
}

/** `containers`, plus `containers-2`... when the controls do not fit in one panel. */
export function containerPanels(input: ContainersInput): Record<string, PanelView> {
  const entries = [...input.control, ...input.status].map((t) => ({
    target: t,
    info: input.infos.get(t.name),
    item: containerItem(input.infos.get(t.name), t.name),
  }));
  const running = entries.filter((e) => e.info && isRunning(e.info)).length;
  const bad = entries.filter((e) => e.item.state === 'bad' || e.item.state === 'unknown').length;
  const warn = entries.filter((e) => e.item.state === 'warn').length;
  const byTarget = new Set(input.control.map((t) => t.name));
  const head: Block[] = [
    {
      type: 'stat',
      id: 'running',
      label: 'Running',
      value: `${String(running)}/${String(entries.length)}`,
      tone: toneFor(bad, warn),
    },
    {
      type: 'stat',
      id: 'attention',
      label: 'Needs attention',
      value: bad + warn,
      tone: toneFor(bad, warn),
    },
    ...statusBlocks(
      'Managed',
      entries.filter((e) => byTarget.has(e.target.name)).map((e) => e.item),
      'managed',
    ),
    ...statusBlocks(
      'Monitored',
      entries.filter((e) => !byTarget.has(e.target.name)).map((e) => e.item),
      'monitored',
    ),
  ];
  const groups = input.control.flatMap((target) => {
    const info = input.infos.get(target.name);
    if (!info) return [];
    const buttons = verbsFor(info.state).map((verb) => button(verb, target, input.permission));
    return buttons.length > 0 ? [buttons] : [];
  });
  const controls = actionBlocks(groups, 'ctl');
  const tail = stamp(input.now);

  const panels: Record<string, PanelView> = {};
  const room = MAX_BLOCKS - head.length - 1;
  const first = controls.slice(0, Math.max(0, room));
  panels['containers'] = { title: 'Containers', blocks: [...head, ...first, tail] };
  let rest = controls.slice(first.length);
  for (let n = 2; rest.length > 0; n++) {
    panels[`containers-${String(n)}`] = {
      title: 'Containers (continued)',
      blocks: [...rest.slice(0, MAX_BLOCKS - 1), tail],
    };
    rest = rest.slice(MAX_BLOCKS - 1);
  }
  return panels;
}

export interface GamesInput {
  servers: readonly {
    target: Extract<Target, { kind: 'game' }>;
    resources: GameResources | undefined;
  }[];
  permission: string;
  now: Date;
}

export function gameItem(name: string, r: GameResources | undefined): Item {
  if (!r || r.state === 'unknown')
    return { label: name, state: 'unknown', detail: 'no answer from the panel' };
  const state: ItemState =
    r.state === 'running'
      ? 'ok'
      : r.state === 'starting' || r.state === 'stopping'
        ? 'warn'
        : 'off';
  const memory =
    r.memoryLimitMb > 0
      ? `${gib(r.memoryBytes)}/${gib(r.memoryLimitMb * 1024 ** 2)} GB`
      : `${gib(r.memoryBytes)} GB`;
  const detail =
    r.state === 'offline'
      ? 'offline'
      : `${r.state} · CPU ${r.cpuPercent.toFixed(0)}% · ${memory} · up ${formatDuration(r.uptimeMs)}`;
  return { label: name, state, detail };
}

export function gamesPanel(input: GamesInput): PanelView {
  if (input.servers.length === 0) {
    return {
      title: 'Game servers',
      blocks: [
        { type: 'markdown', text: 'No game servers are visible to this bot.' },
        stamp(input.now),
      ],
    };
  }
  const up = input.servers.filter((s) => s.resources?.state === 'running').length;
  const groups = input.servers.flatMap(({ target, resources }) => {
    const buttons = verbsFor(resources?.state ?? 'unknown').map((verb) =>
      button(verb, target, input.permission),
    );
    return buttons.length > 0 ? [buttons] : [];
  });
  const blocks: Block[] = [
    {
      type: 'stat',
      id: 'online',
      label: 'Online',
      value: `${String(up)}/${String(input.servers.length)}`,
      tone: up > 0 ? 'good' : 'neutral',
    },
    ...statusBlocks(
      'Servers',
      input.servers.map(({ target, resources }) => gameItem(target.name, resources)),
      'servers',
    ),
    ...actionBlocks(groups, 'pwr'),
  ];
  return { title: 'Game servers', blocks: [...blocks.slice(0, MAX_BLOCKS - 1), stamp(input.now)] };
}

export function monitorsPanel(monitors: readonly Monitor[], now: Date): PanelView {
  const itemOf = (m: Monitor): Item => ({
    label: m.name,
    state:
      m.status === 1
        ? 'ok'
        : m.status === 0
          ? 'bad'
          : m.status === 2
            ? 'warn'
            : m.status === 3
              ? 'off'
              : 'unknown',
    ...(m.uptime !== undefined && { detail: `${String(m.uptime)}% over 24 h` }),
  });
  const up = monitors.filter((m) => m.status === 1).length;
  const down = monitors.filter((m) => m.status === 0).length;
  const groups = new Map<string, Item[]>();
  for (const m of monitors) groups.set(m.group, [...(groups.get(m.group) ?? []), itemOf(m)]);
  const blocks: Block[] = [
    {
      type: 'stat',
      id: 'up',
      label: 'Up',
      value: `${String(up)}/${String(monitors.length)}`,
      tone: down > 0 ? 'bad' : 'good',
    },
  ];
  let n = 0;
  for (const [group, items] of groups) {
    blocks.push(...statusBlocks(group || 'Monitors', items, `group-${String(++n)}`));
  }
  return { title: 'Monitors', blocks: [...blocks.slice(0, MAX_BLOCKS - 1), stamp(now)] };
}
