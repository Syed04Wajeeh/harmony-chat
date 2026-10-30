import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import type { Message } from '@harmony/shared';
import {
  daemonPaths,
  intFrom,
  parseApprovalSettings,
  requireToken,
  type ApprovalSettings,
  type DaemonPaths,
} from './agentd-config.js';
import { callDaemon, type AgentdReply, type AgentdRequest } from './agentd-client.js';
import { Approvals, personOf } from './approvals.js';
import { HarmonyClient, type InteractionAnswer } from './client.js';
import { ConfigError } from './config.js';
import {
  ControlRoom,
  cleanName,
  sessionStatus,
  type Agent,
  type ControlEvent,
  type Person,
  type Session,
} from './control.js';
import {
  PAUSE_BUTTON,
  RESUME_BUTTON,
  STOP_BUTTON,
  agentKey,
  renderAgent,
  renderSession,
  sessionKey,
} from './control-view.js';
import { defuseMassMentions } from './format.js';
import { preToolUseOutput, subjectOf, type HookInput } from './hook.js';
import { PanelSync } from './panel-sync.js';
import { clip, describeActivity, oneLine, redact } from './redact.js';
import { ChannelResolver } from './tools.js';

export interface AgentdConfig {
  url: string;
  token: string;
  /** Channel (kind dashboard or text) that holds the panels. */
  dashboardChannel: string;
  /** Text channel for approvals; unset means the approval pattern is not used. */
  approvalChannel: string | undefined;
  /** Text channel for "needs your input" notes; unset: none are posted. */
  notifyChannel: string | undefined;
  /** Text channel watched for notes to the agents; unset turns steering off. */
  steerChannel: string | undefined;
  approval: ApprovalSettings;
  /** Permission a person needs to press Stop, Pause or Resume. */
  controlPermission: string;
  /** If set, only these logins may steer. */
  steerUsers: Set<string> | undefined;
  controls: boolean;
  pauseWaitMs: number;
  idleMs: number;
  staleMs: number;
  panelMinIntervalMs: number;
  panelGapMs: number;
  keepFinished: number;
  keepEndedSessions: number;
  summaryLines: number;
  includeText: boolean;
  /** How often the daemon looks for stale sessions and idleness (tests lower it). */
  tickMs: number;
  paths: DaemonPaths;
}

const list = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export function loadAgentdConfig(env: Record<string, string | undefined>): AgentdConfig {
  const token = requireToken(env);
  const dashboardChannel = (env.HARMONY_DASHBOARD_CHANNEL ?? env.HARMONY_HOOK_RUN_CHANNEL)?.trim();
  if (!dashboardChannel) {
    throw new ConfigError(
      'Set HARMONY_DASHBOARD_CHANNEL to the channel that shows the agent panels.',
    );
  }
  const agentChannel = (env.HARMONY_AGENT_CHANNEL ?? env.HARMONY_DEFAULT_CHANNEL)?.trim();
  const approvalChannel = env.HARMONY_APPROVAL_CHANNEL?.trim() || agentChannel || undefined;
  const approval = parseApprovalSettings(env);
  const users = list(env.HARMONY_STEER_USERS);
  const pauseSeconds = intFrom(
    env.HARMONY_AGENTD_PAUSE_SECONDS,
    120,
    'HARMONY_AGENTD_PAUSE_SECONDS',
  );
  return {
    url: (env.HARMONY_URL?.trim() || 'http://127.0.0.1:8471').replace(/\/+$/, ''),
    token,
    dashboardChannel,
    approvalChannel,
    notifyChannel: env.HARMONY_AGENTD_NOTIFY === '0' ? undefined : agentChannel,
    steerChannel: env.HARMONY_STEER_CHANNEL?.trim() || undefined,
    approval,
    controlPermission: env.HARMONY_CONTROL_PERMISSION?.trim() || 'manage_messages',
    steerUsers: users.length > 0 ? new Set(users) : undefined,
    controls: env.HARMONY_AGENTD_CONTROLS !== '0',
    pauseWaitMs: pauseSeconds * 1000,
    idleMs: intFrom(env.HARMONY_AGENTD_IDLE_MINUTES, 30, 'HARMONY_AGENTD_IDLE_MINUTES') * 60_000,
    staleMs: intFrom(env.HARMONY_AGENTD_STALE_MINUTES, 30, 'HARMONY_AGENTD_STALE_MINUTES') * 60_000,
    panelMinIntervalMs: intFrom(
      env.HARMONY_PANEL_MIN_INTERVAL_MS,
      1000,
      'HARMONY_PANEL_MIN_INTERVAL_MS',
      0,
    ),
    panelGapMs: intFrom(env.HARMONY_AGENTD_PANEL_GAP_MS, 150, 'HARMONY_AGENTD_PANEL_GAP_MS', 0),
    keepFinished: intFrom(env.HARMONY_AGENTD_KEEP_FINISHED, 10, 'HARMONY_AGENTD_KEEP_FINISHED', 0),
    keepEndedSessions: intFrom(env.HARMONY_AGENTD_KEEP_ENDED, 2, 'HARMONY_AGENTD_KEEP_ENDED', 0),
    summaryLines: intFrom(env.HARMONY_AGENTD_SUMMARY_LINES, 2, 'HARMONY_AGENTD_SUMMARY_LINES', 0),
    includeText: env.HARMONY_HOOK_INCLUDE_TEXT === '1',
    tickMs: intFrom(env.HARMONY_AGENTD_TICK_MS, 30_000, 'HARMONY_AGENTD_TICK_MS', 10),
    paths: daemonPaths(env, token),
  };
}

export class AlreadyRunning extends Error {}

/**
 * Takes the pidfile, or throws `AlreadyRunning` when a live daemon holds it: its process is alive
 * and either answers on the socket or only just wrote the file (it is about to listen).
 */
async function claimPidfile(paths: DaemonPaths): Promise<void> {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(paths.pid, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch {
      let owner = 0;
      let age = Infinity;
      try {
        owner = Number(readFileSync(paths.pid, 'utf8').trim());
        age = Date.now() - statSync(paths.pid).mtimeMs;
      } catch {
        // gone between the attempts: try again
      }
      let alive = false;
      if (owner) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch {
          // not running
        }
      }
      if (
        alive &&
        (age < 10_000 || (await callDaemon(paths.socket, { v: 1, op: 'ping' })).reply?.ok)
      ) {
        throw new AlreadyRunning();
      }
      rmSync(paths.pid, { force: true });
    }
  }
  throw new AlreadyRunning();
}

const out = (output: unknown): { output?: string } => ({ output: JSON.stringify(output) });

const additionalContext = (eventName: string, text: string) =>
  out({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });

export interface Agentd {
  room: ControlRoom;
  sync: PanelSync;
  config: AgentdConfig;
  /** Handles one hook event; `announce` is called first when the answer will take a while. */
  handle(event: ControlEvent, announce?: (waitMs: number) => void): Promise<{ output?: string }>;
  /** Resolves when the daemon decided to exit (idle) or `close` ran. */
  closed: Promise<void>;
  close(): Promise<void>;
  /** Warnings and errors the daemon logged, for tests. */
  log: string[];
}

export interface AgentdDeps {
  client?: HarmonyClient;
  now?: () => number;
  /** Don't listen on a socket (unit tests drive `handle` directly). */
  noSocket?: boolean;
  /** Don't write the pidfile. */
  noPidfile?: boolean;
}

export async function startAgentd(config: AgentdConfig, deps: AgentdDeps = {}): Promise<Agentd> {
  const now = deps.now ?? Date.now;
  const log: string[] = [];
  const warn = (text: string) => {
    log.push(text);
    if (log.length > 100) log.shift();
    if (!deps.noSocket)
      console.error(`harmony-agentd: ${text.replaceAll(config.token, '[token]')}`);
  };
  if (!deps.noPidfile) await claimPidfile(config.paths);

  const client = deps.client ?? new HarmonyClient({ url: config.url, token: config.token });
  const resolver = new ChannelResolver(client, undefined);
  const approvals = new Approvals(client);
  const room = new ControlRoom({
    now,
    keepFinished: config.keepFinished,
    summaryLines: config.summaryLines,
    includeText: config.includeText,
  });
  const viewOptions = () => ({ permission: config.controlPermission, now: now() });

  let dashboardId: string | undefined;
  let approvalId: string | undefined;
  let notifyId: string | undefined;
  let steerId: string | undefined;
  let cleaned = false;
  const resolveChannels = async () => {
    dashboardId ??= await resolver.resolve(config.dashboardChannel, ['dashboard', 'text']);
    if (!cleaned) {
      cleaned = true;
      // Panels left by an earlier daemon would show buttons that do nothing.
      try {
        for (const panel of await client.listPanels(dashboardId)) {
          if (panel.botId === client.botId && /^(cc|ag)-/.test(panel.key)) {
            await client.deletePanel(dashboardId, panel.key);
          }
        }
      } catch (error) {
        warn(`could not clear old panels: ${error instanceof Error ? error.message : 'error'}`);
      }
    }
    return dashboardId;
  };

  const removeSessionPanels = (session: Session) => {
    for (const agent of session.agents.values()) void sync.remove(agentKey(session, agent));
    void sync.remove(sessionKey(session));
    room.sessions.delete(session.id);
  };

  /** Which panel may go when the channel is full: the oldest finished subagent, then an ended session. */
  const pickVictim = (): string | undefined => {
    const finished = [...room.sessions.values()]
      .flatMap((session) =>
        [...session.agents.values()]
          .filter((agent) => agent.endedAt !== undefined)
          .map((agent) => ({ key: agentKey(session, agent), at: agent.endedAt ?? 0 })),
      )
      .sort((a, b) => a.at - b.at)[0];
    if (finished) return finished.key;
    const ended = [...room.sessions.values()]
      .filter((session) => session.endedAt !== undefined)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))[0];
    return ended ? sessionKey(ended) : undefined;
  };
  const onEvicted = (key: string) => {
    for (const session of room.sessions.values()) {
      if (key === sessionKey(session)) {
        room.sessions.delete(session.id);
        return;
      }
      for (const agent of session.agents.values()) {
        if (key === agentKey(session, agent)) {
          room.forget(session, agent);
          return;
        }
      }
    }
  };

  const sync = new PanelSync(client, {
    minIntervalMs: config.panelMinIntervalMs,
    gapMs: config.panelGapMs,
    pickVictim,
    onEvicted,
    ...(deps.now && { now: deps.now }),
    onError: warn,
  });

  // -- panels follow the model -----------------------------------------------------------------

  const publish = async (session: Session, agent: Agent | undefined) => {
    let channelId: string;
    try {
      channelId = await resolveChannels();
    } catch (error) {
      warn(`dashboard channel unavailable: ${error instanceof Error ? error.message : 'error'}`);
      return;
    }
    const controls = config.controls;
    sync.set(channelId, sessionKey(session), () => {
      const view = renderSession(session, viewOptions());
      return controls ? view : stripActions(view);
    });
    if (agent && session.agents.get(agent.id) === agent) {
      sync.set(channelId, agentKey(session, agent), () => {
        const view = renderAgent(session, agent, viewOptions());
        return controls ? view : stripActions(view);
      });
    }
    for (const old of room.prunable(session)) {
      await sync.remove(agentKey(session, old));
      room.forget(session, old);
    }
    const ended = [...room.sessions.values()]
      .filter((candidate) => candidate.endedAt !== undefined)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const stale of ended.slice(config.keepEndedSessions)) removeSessionPanels(stale);
  };
  room.onChange = (session, agent) => {
    void publish(session, agent);
    void syncGateway();
  };

  // -- the gateway socket: held while a session lives ------------------------------------------

  let release: (() => void) | undefined;
  let acquiring = false;
  let unwatch: (() => void) | undefined;
  let removeListener: (() => void) | undefined;
  let lastSteerId = '0';
  const seenSteer = new Set<string>();

  client.setInteractionHandler((interaction) => {
    if (interaction.type !== 'action') {
      return { type: 'message', content: 'Nothing to do here.', ephemeral: true };
    }
    const source = interaction.action.source;
    const person = personOf(interaction);
    if (source.kind === 'message') {
      return approvals.handleAction(source.messageId, interaction.action.id, person);
    }
    return handlePanelAction(source.key, interaction.action.id, person);
  });

  function handlePanelAction(key: string, actionId: string, person: Person): InteractionAnswer {
    const gone: InteractionAnswer = {
      type: 'message',
      content: 'That agent is no longer being tracked.',
      ephemeral: true,
    };
    for (const session of room.sessions.values()) {
      if (key === sessionKey(session)) {
        if (actionId === STOP_BUTTON) {
          return room.stopSession(session, person)
            ? say('Stop requested. Every tool call of this session is refused from now on.')
            : say('This session is already stopped or has ended.');
        }
        if (actionId === PAUSE_BUTTON) {
          return room.pause(session, person)
            ? say('Paused. Tool calls wait until you press Resume.')
            : say('Cannot pause this session now.');
        }
        if (actionId === RESUME_BUTTON) {
          return room.resume(session, person) ? say('Resumed.') : say('It is not paused.');
        }
        return gone;
      }
      for (const agent of session.agents.values()) {
        if (key === agentKey(session, agent)) {
          if (actionId !== STOP_BUTTON) return gone;
          return room.stopAgent(session, agent, person)
            ? say('Stop requested. This agent’s next tool call is refused.')
            : say('This agent is already stopping or has finished.');
        }
      }
    }
    return gone;
  }
  const say = (content: string): InteractionAnswer => ({
    type: 'message',
    content,
    ephemeral: true,
  });

  async function syncGateway(): Promise<void> {
    const wanted = room.live().length > 0;
    if (wanted && !release && !acquiring) {
      acquiring = true;
      try {
        release = await client.holdGateway();
        await watchSteer();
      } catch (error) {
        warn(`gateway: ${error instanceof Error ? error.message : 'error'}`);
      } finally {
        acquiring = false;
      }
    } else if (!wanted && release) {
      unwatch?.();
      removeListener?.();
      unwatch = removeListener = undefined;
      release();
      release = undefined;
    }
  }

  // -- steering: messages in the steer channel ---------------------------------------------------

  async function watchSteer(): Promise<void> {
    if (!config.steerChannel || unwatch) return;
    steerId ??= await resolver.resolve(config.steerChannel, ['text']);
    const channelId = steerId;
    if (lastSteerId === '0') {
      lastSteerId = (await client.getMessages(channelId, { limit: 1 })).messages.at(-1)?.id ?? '0';
    }
    const link = client.gateway;
    removeListener = link.addListener({
      channelId,
      onMessage: (message) => onSteerMessage(message),
      onGap: () => {
        client.getMessages(channelId, { limit: 30 }).then(
          (page) => page.messages.forEach((message) => onSteerMessage(message)),
          (error: unknown) => warn(`steer catch-up: ${String(error)}`),
        );
      },
      onFatal: (code) => warn(`steer channel: ${code}`),
    });
    unwatch = link.watch(channelId, lastSteerId).unwatch;
  }

  function onSteerMessage(message: Message): void {
    if (BigInt(message.id) <= BigInt(lastSteerId) || seenSteer.has(message.id)) return;
    seenSteer.add(message.id);
    if (seenSteer.size > 500) seenSteer.delete(seenSteer.values().next().value as string);
    lastSteerId = message.id;
    if (message.author.isBot || message.deleted || message.webhookId) return;
    if (config.steerUsers && !config.steerUsers.has(message.author.login.toLowerCase())) return;
    const from: Person = {
      id: message.author.id,
      login: message.author.login,
      displayName: message.author.displayName,
    };
    const mention = `<@${client.botId}>`;
    const mentioned = message.content.includes(mention);
    const live = room.live();
    let session: Session | undefined;
    let agent: Agent | undefined;
    let text = message.content.replaceAll(mention, '').trim();
    if (message.replyTo) {
      session = live.find((candidate) => candidate.statusMessageId === message.replyTo?.id);
    }
    if (!session && mentioned) {
      const first = text.split(/\s+/)[0]?.toLowerCase().replace(/^#/, '') ?? '';
      for (const candidate of live) {
        if (first === candidate.short) {
          session = candidate;
          text = text.slice(first.length + (text.startsWith('#') ? 1 : 0)).trim();
          break;
        }
        const match = [...candidate.agents.values()].find((a) => a.short === first);
        if (match) {
          session = candidate;
          agent = match;
          text = text.slice(first.length + (text.startsWith('#') ? 1 : 0)).trim();
          break;
        }
      }
      if (!session && live.length === 1) session = live[0];
      if (!session) {
        const which = live.map((candidate) => `\`${candidate.short}\` (${candidate.folder})`);
        void client
          .sendMessage(message.channelId, {
            content: defuseMassMentions(
              which.length > 0
                ? `Which session? Start your note with an id: ${which.join(', ')}.`
                : 'No Claude Code session is running right now.',
            ),
            replyToId: message.id,
          })
          .catch(() => undefined);
        return;
      }
    }
    if (!session || text === '') return;
    if (agent && agent.endedAt !== undefined) agent = undefined;
    const queued = room.queueSteer(session, agent, from, text);
    const target = agent ? `subagent '${agent.label}'` : `session \`${session.short}\``;
    void client
      .sendMessage(message.channelId, {
        content: defuseMassMentions(
          queued
            ? `Noted. It reaches ${target} with its next tool result.`
            : `Too many notes are waiting for ${target}; try again in a moment.`,
        ),
        replyToId: message.id,
      })
      .catch(() => warn('could not acknowledge a steering message'));
  }

  async function postStatusMessage(session: Session): Promise<void> {
    if (!config.steerChannel) return;
    try {
      steerId ??= await resolver.resolve(config.steerChannel, ['text']);
      const posted = await client.sendMessage(steerId, {
        content: defuseMassMentions(
          `**Claude Code** in \`${session.folder.replaceAll('`', '') || 'a folder'}\` · session \`${session.short}\`\nReply to this message, or mention me and start with \`${session.short}\`, to send the agent a note. It arrives with its next tool result and is marked as coming from chat.`,
        ),
      });
      session.statusMessageId = posted.id;
    } catch (error) {
      warn(`steer status message: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  // -- events -----------------------------------------------------------------------------------

  const stripActions = <T extends { blocks: { type: string }[] }>(view: T): T => ({
    ...view,
    blocks: view.blocks.filter((block) => block.type !== 'actions'),
  });

  async function notify(session: Session, text: string): Promise<void> {
    if (!config.notifyChannel) return;
    try {
      notifyId ??= await resolver.resolve(config.notifyChannel, ['text']);
      await client.sendMessage(notifyId, {
        content: defuseMassMentions(
          `**Claude Code needs your input** · \`${session.folder.replaceAll('`', '') || 'session'}\` \`${session.short}\`\n${redact(clip(text, 600)).text}`,
        ).replaceAll('<@', '<​@'),
      });
    } catch (error) {
      warn(`notification: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  function whoLabel(session: Session, agent: Agent | undefined): string {
    return agent ? `Subagent '${agent.label}'` : `Claude Code (${session.folder || 'session'})`;
  }

  async function askApproval(
    event: ControlEvent,
    session: Session,
    agent: Agent | undefined,
    announce: (waitMs: number) => void,
  ): Promise<{ output?: string }> {
    approvalId ??= await resolver.resolve(config.approvalChannel, ['text']);
    announce(config.approval.approvalSeconds * 1000);
    const label = whoLabel(session, agent);
    const subject = redact(oneLine(subjectOf(event as HookInput)));
    const detailLines = [
      `Asked by: ${label}${agent ? ` (\`${cleanName(agent.type)}\`)` : ''} · folder \`${(session.folder || '?').replaceAll('`', '')}\` · session \`${session.short}\``,
      '```',
      clip(redact(subjectOf(event as HookInput)).text.replaceAll('```', "'''"), 1200),
      '```',
    ];
    if (subject.changed) detailLines.push('Parts that looked like secrets are hidden.');
    session.approvals += 1;
    if (agent) agent.approvals += 1;
    room.onChange(session, agent);
    let result;
    try {
      result = await approvals.request({
        channelId: approvalId,
        title: clip(`${label} wants to run: ${clip(subject.text, 110)}`, 200),
        details: defuseMassMentions(detailLines.join('\n')).replaceAll('<@', '<​@'),
        risk: config.approval.risk,
        timeoutMs: config.approval.approvalSeconds * 1000,
        requiredPermission: config.approval.permission,
        signal: session.abort.signal,
      });
    } finally {
      session.approvals -= 1;
      if (agent) agent.approvals -= 1;
      room.onChange(session, agent);
    }
    const who = result.by ? `${result.by.displayName} (@${result.by.login})` : 'someone';
    room.note(
      session,
      `${result.decision} ${describeActivity(event.tool_name, event.tool_input, session.cwd)}${result.by ? ` by ${cleanName(result.by.displayName)}` : ''}`,
    );
    if (result.decision === 'approved') {
      return out(permission('allow', `Approved in Harmony by ${who}.`));
    }
    if (result.decision === 'denied') {
      return out(permission('deny', `Denied in Harmony by ${who}.`));
    }
    if (result.decision === 'cancelled') {
      const stop = session.stopped ?? agent?.stopped;
      return out(
        permission(
          'deny',
          stop
            ? room.stopReason(stop.by, session.stopped ? 'session' : 'subagent')
            : 'The approval was cancelled.',
        ),
      );
    }
    return out(
      permission(
        config.approval.onTimeout,
        `No decision in Harmony within ${String(config.approval.approvalSeconds)}s${config.approval.onTimeout === 'ask' ? '; asking in the terminal.' : '; denied.'}`,
      ),
    );
  }

  function permission(decision: 'allow' | 'deny' | 'ask', reason: string): unknown {
    return JSON.parse(preToolUseOutput(decision, reason)) as unknown;
  }

  async function handle(
    event: ControlEvent,
    announce: (waitMs: number) => void = () => undefined,
  ): Promise<{ output?: string }> {
    const isNew = !room.sessions.has(event.session_id);
    const { session, agent } = room.ingest(event);
    if (isNew) void postStatusMessage(session);
    switch (event.hook_event_name) {
      case 'PreToolUse': {
        for (;;) {
          const gate = room.gate(session, agent);
          if (gate.type === 'deny') return out(permission('deny', gate.reason));
          if (gate.type === 'allow') break;
          announce(config.pauseWaitMs);
          const resumed = await room.waitWhilePaused(session, config.pauseWaitMs);
          if (!resumed) {
            return out(
              permission(
                'deny',
                `This session is paused from Harmony by ${cleanName(gate.by.displayName)}. Do not retry now; tell the user you are waiting to be resumed.`,
              ),
            );
          }
        }
        const pattern = config.approval.approvalPattern;
        if (pattern && config.approvalChannel && pattern.test(subjectOf(event as HookInput))) {
          const decision = await askApproval(event, session, agent, announce);
          // A denied or stopped call does not count as work done.
          if (!decision.output?.includes('"deny"')) room.toolStarted(session, agent, event);
          return decision;
        }
        room.toolStarted(session, agent, event);
        return {};
      }
      case 'PostToolUse': {
        const text = room.takeSteer(session, agent);
        return text ? additionalContext('PostToolUse', text) : {};
      }
      case 'UserPromptSubmit': {
        const text = room.takeSteer(session, undefined);
        return text ? additionalContext('UserPromptSubmit', text) : {};
      }
      case 'Stop': {
        // Notes that arrived while the agent was finishing: one more round, once per Stop.
        if (agent || event.stop_hook_active || session.stopped) return {};
        const text = room.takeSteer(session, undefined);
        return text ? additionalContext('Stop', text) : {};
      }
      case 'Notification':
        if (event.notification_type !== 'auth_success' && event.message) {
          void notify(session, event.message);
        }
        return {};
      case 'SessionEnd':
        if (session.statusMessageId && steerId) {
          void client
            .editMessage(
              session.statusMessageId,
              `Claude Code session \`${session.short}\` ended.`,
              {
                clearComponents: true,
              },
            )
            .catch(() => undefined);
        }
        return {};
      default:
        return {};
    }
  }

  // -- the unix socket ----------------------------------------------------------------------------

  let lastActivity = now();
  let server: net.Server | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const isEvent = (value: unknown): value is ControlEvent =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ControlEvent).session_id === 'string' &&
    typeof (value as ControlEvent).hook_event_name === 'string';

  async function serve(socket: net.Socket, request: AgentdRequest): Promise<void> {
    const write = (reply: AgentdReply) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
    };
    lastActivity = now();
    try {
      if (request.op === 'ping') return write({ ok: true });
      if (request.op === 'status') {
        return write({
          ok: true,
          status: [...room.sessions.values()].map((session) => ({
            session: session.short,
            status: sessionStatus(session),
            agents: session.agents.size,
          })),
        });
      }
      if (request.op === 'shutdown') {
        write({ ok: true });
        setImmediate(() => void close());
        return;
      }
      if (request.op === 'event' && isEvent(request.event)) {
        const { output } = await handle(request.event, (waitMs) => write({ ack: true, waitMs }));
        return write({ ok: true, ...(output && { output }) });
      }
      write({ ok: false, error: 'bad_request' });
    } catch (error) {
      warn(`event failed: ${error instanceof Error ? error.message : 'error'}`);
      write({ ok: false, error: 'internal' });
    } finally {
      socket.end();
    }
  }

  if (!deps.noSocket) {
    try {
      // A stale socket file from a dead daemon is replaced; a live one was ruled out by the pidfile.
      rmSync(config.paths.socket, { force: true });
      server = net.createServer((socket) => {
        let buffer = '';
        let handled = false;
        socket.setEncoding('utf8');
        socket.setTimeout(5000, () => socket.destroy());
        socket.on('error', () => undefined);
        socket.on('data', (chunk: string) => {
          if (handled) return;
          buffer += chunk;
          if (buffer.length > 256 * 1024) return socket.destroy();
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          handled = true;
          socket.setTimeout(0);
          let request: AgentdRequest;
          try {
            request = JSON.parse(buffer.slice(0, newline)) as AgentdRequest;
          } catch {
            socket.end(`${JSON.stringify({ ok: false, error: 'bad_json' })}\n`);
            return;
          }
          void serve(socket, request);
        });
      });
      const previous = process.umask(0o177);
      try {
        await new Promise<void>((resolve, reject) => {
          server?.once('error', reject);
          server?.listen(config.paths.socket, resolve);
        });
      } finally {
        process.umask(previous);
      }
      chmodSync(config.paths.socket, 0o600);
    } catch (error) {
      rmSync(config.paths.pid, { force: true });
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new AlreadyRunning();
      throw error;
    }
  }

  const tick = setInterval(() => {
    room.expireStale(config.staleMs);
    void syncGateway();
    if (room.live().length === 0 && now() - lastActivity > config.idleMs) void close();
  }, config.tickMs);
  tick.unref();
  // Elapsed time moves without events; running panels are refreshed now and then.
  const heartbeat = setInterval(() => {
    for (const session of room.live()) {
      void publish(session, undefined);
      for (const agent of session.agents.values()) {
        if (agent.endedAt === undefined) void publish(session, agent);
      }
    }
  }, 30_000);
  heartbeat.unref();

  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    closing ??= (async () => {
      clearInterval(tick);
      clearInterval(heartbeat);
      room.onChange = () => undefined;
      await sync.flush().catch(() => undefined);
      sync.close();
      unwatch?.();
      removeListener?.();
      release?.();
      release = undefined;
      client.closeGateway();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      if (!deps.noSocket) {
        rmSync(config.paths.socket, { force: true });
        rmSync(config.paths.pid, { force: true });
      }
      resolveClosed();
    })();
    return closing;
  }

  return { room, sync, config, handle, closed, close, log };
}

/** Asks a running daemon to exit (used by tests and `harmony-agentd stop`). */
export async function stopDaemon(socket: string): Promise<boolean> {
  const { reply } = await callDaemon(socket, { v: 1, op: 'shutdown' });
  return reply?.ok === true;
}
