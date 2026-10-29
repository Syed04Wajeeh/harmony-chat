import { randomBytes } from 'node:crypto';
import type { Block, PanelView } from '@harmony/shared';
import type { HarmonyClient, InteractionAnswer } from './client.js';
import { HarmonyError } from './client.js';

export type RunStatus =
  'running' | 'waiting_approval' | 'waiting_reply' | 'done' | 'failed' | 'cancelled';

export const ACTIVE_STATUSES: readonly RunStatus[] = [
  'running',
  'waiting_approval',
  'waiting_reply',
];

const LABELS: Record<RunStatus, string> = {
  running: 'Running',
  waiting_approval: 'Waiting for approval',
  waiting_reply: 'Waiting for reply',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const TONES: Record<RunStatus, 'neutral' | 'good' | 'warn' | 'bad'> = {
  running: 'neutral',
  waiting_approval: 'warn',
  waiting_reply: 'warn',
  done: 'good',
  failed: 'bad',
  cancelled: 'neutral',
};

const MAX_NOTES = 5;
const NOTE_LENGTH = 200;
const HEARTBEAT_MS = 30_000;
const CANCEL_BUTTON = 'cancel';

export interface Person {
  id: string;
  login: string;
  displayName: string;
}

export interface Note {
  at: number;
  text: string;
}

export interface Run {
  id: string;
  key: string;
  channelId: string;
  title: string;
  status: RunStatus;
  step: string;
  steps: number;
  totalSteps: number | undefined;
  startedAt: number;
  endedAt: number | undefined;
  notes: Note[];
  link: string | undefined;
  summary: string | undefined;
  cancelledBy: Person | undefined;
  /** Aborted when a person cancels the run; waits and approvals listen to it. */
  abort: AbortController;
}

export interface RunOptions {
  /** Minimum time between two panel writes of one run. */
  minIntervalMs: number;
  /** Permission needed to press Cancel. */
  permission: string;
  /** Show a Cancel button. Off when nothing in this process listens for the click. */
  cancellable: boolean;
  now?: () => number;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h)}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${String(m)}m ${String(s).padStart(2, '0')}s`;
  return `${String(s)}s`;
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 19);

/** The panel for a run. Everything the agent wrote is clipped to the panel's own limits. */
export function renderRun(run: Run, options: RunOptions, now: number): PanelView {
  const active = ACTIVE_STATUSES.includes(run.status);
  const elapsed = (run.endedAt ?? now) - run.startedAt;
  const blocks: Block[] = [
    {
      type: 'stat',
      id: 'status',
      label: 'Status',
      value: LABELS[run.status],
      tone: TONES[run.status],
      span: 1,
    },
    {
      type: 'stat',
      id: 'steps',
      label: 'Steps',
      value: run.totalSteps ? `${String(run.steps)} / ${String(run.totalSteps)}` : run.steps,
      span: 1,
    },
    { type: 'stat', id: 'elapsed', label: 'Elapsed', value: formatDuration(elapsed), span: 1 },
  ];
  if (run.totalSteps) {
    blocks.push({
      type: 'progress',
      id: 'progress',
      label: 'Progress',
      value: Math.min(run.steps, run.totalSteps),
      max: run.totalSteps,
      tone: run.status === 'failed' ? 'bad' : run.status === 'done' ? 'good' : 'neutral',
    });
  }
  const pairs: { key: string; value: string }[] = [
    { key: 'Current step', value: clip(run.step || 'Starting', 300) },
    { key: 'Started', value: new Date(run.startedAt).toISOString() },
  ];
  if (run.summary) pairs.push({ key: 'Summary', value: clip(run.summary, 300) });
  if (run.cancelledBy) {
    pairs.push({ key: 'Cancelled by', value: clip(run.cancelledBy.displayName, 300) });
  }
  if (run.link) pairs.push({ key: 'Link', value: clip(run.link, 300) });
  blocks.push({ type: 'kv', id: 'info', pairs });
  if (run.notes.length > 0) {
    const lines = run.notes.map((note) => `- \`${clock(note.at)}\` ${note.text}`).join('\n');
    blocks.push({ type: 'markdown', id: 'notes', text: clip(`**Recent notes**\n${lines}`, 3900) });
  }
  if (active && options.cancellable) {
    blocks.push({
      type: 'actions',
      id: 'controls',
      buttons: [
        {
          id: CANCEL_BUTTON,
          label: 'Cancel run',
          style: 'danger',
          confirm: {
            title: 'Cancel this run?',
            body: 'The agent is told to stop at its next step.',
            confirmLabel: 'Cancel run',
          },
          requiredPermission: options.permission,
        },
      ],
    });
  }
  return { title: clip(`Agent run: ${run.title}`, 100), blocks };
}

export type RunSnapshot = Omit<Run, 'abort' | 'cancelledBy'>;

interface Sync {
  timer: NodeJS.Timeout | undefined;
  lastPutAt: number;
  inflight: Promise<void> | undefined;
  dirty: boolean;
}

/**
 * Agent runs shown as panels. Writes are coalesced: a run is written at most once per
 * `minIntervalMs`, so a chatty agent cannot trip the panel rate limit, and the newest state
 * always wins because every write renders the whole current run.
 */
export class RunManager {
  private readonly runs = new Map<string, Run>();
  private readonly sync = new Map<string, Sync>();
  private heartbeat: NodeJS.Timeout | undefined;
  /** The run tools act on when a call names none: the newest one, kept after it is cancelled. */
  current: Run | undefined;
  readonly options: RunOptions;
  /** Panel write failures that happened in the background (the next tool result mentions them). */
  warnings: string[] = [];

  constructor(
    private readonly client: HarmonyClient,
    options: Omit<RunOptions, 'now'> & { now?: () => number },
  ) {
    this.options = options;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  byKey(key: string): Run | undefined {
    return [...this.runs.values()].find((run) => run.key === key);
  }

  active(): Run[] {
    return [...this.runs.values()].filter((run) => ACTIVE_STATUSES.includes(run.status));
  }

  /** The parts of a run worth keeping between processes (the Claude Code hook is one per event). */
  snapshot(run: Run): RunSnapshot {
    return {
      id: run.id,
      key: run.key,
      channelId: run.channelId,
      title: run.title,
      status: run.status,
      step: run.step,
      steps: run.steps,
      totalSteps: run.totalSteps,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      notes: run.notes,
      link: run.link,
      summary: run.summary,
    };
  }

  /** Brings back a run saved by `snapshot`; the panel is written on the next change. */
  restore(saved: RunSnapshot): Run {
    const run: Run = { ...saved, cancelledBy: undefined, abort: new AbortController() };
    this.runs.set(run.id, run);
    this.sync.set(run.id, { timer: undefined, lastPutAt: 0, inflight: undefined, dirty: false });
    this.current = run;
    return run;
  }

  async start(input: {
    channelId: string;
    title: string;
    step?: string | undefined;
    totalSteps?: number | undefined;
    link?: string | undefined;
  }): Promise<Run> {
    const id = randomBytes(4).toString('hex');
    const run: Run = {
      id,
      key: `run-${id}`,
      channelId: input.channelId,
      title: input.title,
      status: 'running',
      step: input.step ?? '',
      steps: input.step ? 1 : 0,
      totalSteps: input.totalSteps,
      startedAt: this.now(),
      endedAt: undefined,
      notes: [],
      link: input.link,
      summary: undefined,
      cancelledBy: undefined,
      abort: new AbortController(),
    };
    this.runs.set(id, run);
    this.sync.set(id, { timer: undefined, lastPutAt: 0, inflight: undefined, dirty: false });
    try {
      await this.putWithRoom(run);
    } catch (error) {
      this.runs.delete(id);
      this.sync.delete(id);
      throw error;
    }
    this.current = run;
    this.startHeartbeat();
    return run;
  }

  /** The panel limit is per channel; make room by removing this bot's own finished runs. */
  private async putWithRoom(run: Run): Promise<void> {
    try {
      await this.put(run);
    } catch (error) {
      if (!(error instanceof HarmonyError) || error.code !== 'panel_limit') throw error;
      const panels = await this.client.listPanels(run.channelId);
      const victim = panels
        .filter((panel) => {
          if (panel.botId !== this.client.botId || !panel.key.startsWith('run-')) return false;
          const known = this.byKey(panel.key);
          return !known || known.endedAt !== undefined;
        })
        .sort((x, y) => x.updatedAt.localeCompare(y.updatedAt))[0];
      if (!victim) throw error;
      await this.client.deletePanel(run.channelId, victim.key);
      const known = this.byKey(victim.key);
      if (known) {
        this.runs.delete(known.id);
        this.sync.delete(known.id);
      }
      await this.put(run);
    }
  }

  private async put(run: Run): Promise<void> {
    const state = this.sync.get(run.id);
    if (state) {
      state.lastPutAt = this.now();
      state.dirty = false;
    }
    await this.client.putPanel(run.channelId, run.key, renderRun(run, this.options, this.now()));
  }

  update(
    run: Run,
    change: {
      step?: string | undefined;
      status?: RunStatus | undefined;
      note?: string | undefined;
      link?: string | undefined;
      totalSteps?: number | undefined;
    },
  ): void {
    if (change.step !== undefined && change.step !== run.step) {
      run.step = change.step;
      run.steps += 1;
    }
    if (change.totalSteps !== undefined) run.totalSteps = change.totalSteps;
    if (change.link !== undefined) run.link = change.link;
    if (change.status !== undefined) run.status = change.status;
    if (change.note) this.note(run, change.note, false);
    this.schedule(run);
  }

  note(run: Run, text: string, schedule = true): void {
    run.notes.push({ at: this.now(), text: clip(text.replace(/\s+/g, ' ').trim(), NOTE_LENGTH) });
    if (run.notes.length > MAX_NOTES) run.notes.splice(0, run.notes.length - MAX_NOTES);
    if (schedule) this.schedule(run);
  }

  /** Sets a waiting status for the duration of `fn`, then goes back to running. */
  async whileWaiting<T>(
    run: Run | undefined,
    status: 'waiting_approval' | 'waiting_reply',
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!run || !ACTIVE_STATUSES.includes(run.status)) return fn();
    this.update(run, { status });
    try {
      return await fn();
    } finally {
      if (run.status === status) this.update(run, { status: 'running' });
    }
  }

  async finish(run: Run, status: 'done' | 'failed', summary: string | undefined): Promise<void> {
    run.status = status;
    run.endedAt = this.now();
    if (summary) run.summary = summary;
    this.note(run, `${LABELS[status]}${summary ? `: ${summary}` : ''}`, false);
    await this.flush(run);
    this.stopHeartbeatIfIdle();
  }

  /** A person pressed Cancel: stop the run, tell everything waiting on it, show it on the panel. */
  cancel(run: Run, by: Person): void {
    if (!ACTIVE_STATUSES.includes(run.status)) return;
    run.status = 'cancelled';
    run.endedAt = this.now();
    run.cancelledBy = by;
    this.note(run, `Cancelled by ${by.displayName} (@${by.login})`, false);
    run.abort.abort();
    this.schedule(run);
    this.stopHeartbeatIfIdle();
  }

  /** What every tool answers once the run it belongs to is cancelled; undefined otherwise. */
  cancelNotice(run: Run | undefined = this.current): string | undefined {
    if (run?.status !== 'cancelled') return undefined;
    const by = run.cancelledBy;
    return `This run was cancelled by ${by ? `${by.displayName} (@${by.login})` : 'a person'}; stop working. Do not continue the task or retry it, and tell the user you stopped.`;
  }

  /** Handles a click on a run panel's button. */
  handleAction(key: string, actionId: string, user: Person): InteractionAnswer {
    const run = this.byKey(key);
    if (!run || actionId !== CANCEL_BUTTON) {
      return { type: 'message', content: 'This run is no longer active.', ephemeral: true };
    }
    if (!ACTIVE_STATUSES.includes(run.status)) {
      return {
        type: 'message',
        content: `This run is already ${LABELS[run.status].toLowerCase()}.`,
        ephemeral: true,
      };
    }
    this.cancel(run, user);
    return {
      type: 'message',
      content: 'Cancelled. The agent is told to stop at its next tool call.',
      ephemeral: true,
    };
  }

  /** Writes now if the interval allows, otherwise once it has passed. */
  private schedule(run: Run): void {
    const state = this.sync.get(run.id);
    if (!state) return;
    state.dirty = true;
    if (state.timer || state.inflight) return;
    const wait = Math.max(0, state.lastPutAt + this.options.minIntervalMs - this.now());
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.inflight = this.put(run)
        .catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          this.warnings.push(`The run panel could not be updated: ${text}`);
        })
        .finally(() => {
          state.inflight = undefined;
          if (state.dirty) this.schedule(run);
        });
    }, wait);
  }

  /** Writes the latest state and waits for it; used when a run ends. */
  async flush(run: Run): Promise<void> {
    const state = this.sync.get(run.id);
    if (!state) return;
    clearTimeout(state.timer);
    state.timer = undefined;
    await state.inflight;
    const wait = Math.max(0, state.lastPutAt + this.options.minIntervalMs - this.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      await this.put(run);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.warnings.push(`The run panel could not be updated: ${text}`);
    }
  }

  /** Flushes every pending panel write (used when the process shuts down). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => this.flush(run)));
  }

  /** Elapsed time moves without the agent doing anything, so active runs re-render now and then. */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const run of this.active()) this.schedule(run);
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private stopHeartbeatIfIdle(): void {
    if (this.heartbeat && this.active().length === 0) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  takeWarnings(): string {
    const text = this.warnings.splice(0).slice(-2).join(' ');
    return text ? `\n(${text})` : '';
  }
}
