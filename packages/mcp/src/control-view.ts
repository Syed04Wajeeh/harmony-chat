import type { Block, PanelView } from '@harmony/shared';
import {
  agentStatus,
  sessionStatus,
  type Agent,
  type AgentStatusWord,
  type Session,
  type StatusWord,
} from './control.js';
import { clip, oneLine } from './redact.js';
import { formatDuration, stamp } from './runs.js';

export const STOP_BUTTON = 'stop';
export const PAUSE_BUTTON = 'pause';
export const RESUME_BUTTON = 'resume';

type Tone = 'neutral' | 'good' | 'warn' | 'bad';

const SESSION_TONE: Record<StatusWord, Tone> = {
  running: 'neutral',
  'waiting for approval': 'warn',
  'waiting for input': 'warn',
  idle: 'neutral',
  paused: 'warn',
  stopping: 'bad',
  ended: 'neutral',
};
const AGENT_TONE: Record<AgentStatusWord, Tone> = {
  running: 'neutral',
  'waiting for approval': 'warn',
  stopping: 'bad',
  stopped: 'bad',
  done: 'good',
  'ended early': 'warn',
};

const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const clock = (at: number) => new Date(at).toISOString().slice(11, 19);

export const sessionKey = (session: Session) => `cc-${session.short}`;
export const agentKey = (session: Session, agent: Agent) => `ag-${session.short}-${agent.short}`;

export interface ViewOptions {
  /** Permission a person needs to press Stop or Pause. */
  permission: string;
  now: number;
}

const SUBAGENT_ROWS = 12;

/** Running subagents first (newest start first), then the latest finished ones. */
export function orderedAgents(session: Session): Agent[] {
  return [...session.agents.values()].sort((a, b) => {
    const live = Number(b.endedAt === undefined) - Number(a.endedAt === undefined);
    if (live !== 0) return live;
    return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
  });
}

export function renderSession(session: Session, options: ViewOptions): PanelView {
  const status = sessionStatus(session);
  const agents = orderedAgents(session);
  const running = agents.filter((agent) => agent.endedAt === undefined).length;
  const done = agents.length - running + session.prunedAgents;
  const elapsed = (session.endedAt ?? options.now) - session.startedAt;

  const blocks: Block[] = [
    {
      type: 'stat',
      id: 'status',
      label: 'Status',
      value: cap(status),
      tone: SESSION_TONE[status],
      span: 1,
    },
    { type: 'stat', id: 'tools', label: 'Tool calls', value: session.tools, span: 1 },
    {
      type: 'stat',
      id: 'agents',
      label: 'Subagents',
      value: `${String(running)} running · ${String(done)} done`,
      span: 1,
    },
    { type: 'stat', id: 'elapsed', label: 'Elapsed', value: formatDuration(elapsed), span: 1 },
  ];

  const pairs: { key: string; value: string }[] = [
    { key: 'Now', value: clip(session.activity || 'Nothing yet', 300) },
    { key: 'Folder', value: clip(session.folder || 'unknown', 120) },
    { key: 'Session', value: session.short },
  ];
  if (session.model) pairs.push({ key: 'Model', value: session.model });
  if (session.approvals > 0) {
    pairs.push({ key: 'Approvals pending', value: String(session.approvals) });
  }
  if (session.stopped) {
    pairs.push({
      key: 'Stop',
      value: `Requested by ${session.stopped.by.displayName}; the next tool call is refused`,
    });
  }
  if (session.paused) {
    pairs.push({ key: 'Paused', value: `By ${session.paused.by.displayName}; tool calls wait` });
  }
  if (session.denied > 0) pairs.push({ key: 'Refused calls', value: String(session.denied) });
  pairs.push({ key: 'Started', value: stamp(session.startedAt) });
  blocks.push({ type: 'kv', id: 'info', pairs });

  if (agents.length > 0) {
    blocks.push({
      type: 'table',
      id: 'subagents',
      title: 'Subagents',
      columns: [
        { key: 'agent', label: 'Agent' },
        { key: 'status', label: 'Status' },
        { key: 'tools', label: 'Tools', align: 'right' },
        { key: 'detail', label: 'Now / result' },
      ],
      rows: agents.slice(0, SUBAGENT_ROWS).map((agent) => ({
        agent: clip(agent.label, 60),
        status: agentStatus(session, agent),
        tools: agent.tools,
        detail: clip(agent.endedAt === undefined ? agent.activity : (agent.summary ?? ''), 120),
      })),
    });
  }

  if (session.notes.length > 0) {
    const lines = session.notes.map((note) => `- \`${clock(note.at)}\` ${note.text}`).join('\n');
    blocks.push({ type: 'markdown', id: 'notes', text: clip(`**Recent notes**\n${lines}`, 3900) });
  }

  if (session.endedAt === undefined && !session.stopped) {
    blocks.push({
      type: 'actions',
      id: 'controls',
      buttons: [
        session.paused
          ? {
              id: RESUME_BUTTON,
              label: 'Resume',
              style: 'primary',
              requiredPermission: options.permission,
            }
          : {
              id: PAUSE_BUTTON,
              label: 'Pause',
              style: 'secondary',
              requiredPermission: options.permission,
            },
        {
          id: STOP_BUTTON,
          label: 'Stop session',
          style: 'danger',
          confirm: {
            title: 'Stop this Claude Code session?',
            body: 'Its next tool call, and every subagent’s, is refused with a message telling it to stop.',
            confirmLabel: 'Stop session',
          },
          requiredPermission: options.permission,
        },
      ],
    });
  }
  const title = `Claude Code: ${session.folder || 'session'} · ${session.short}`;
  return { title: clip(title, 100), blocks };
}

export function renderAgent(session: Session, agent: Agent, options: ViewOptions): PanelView {
  const status = agentStatus(session, agent);
  const elapsed = (agent.endedAt ?? options.now) - agent.startedAt;
  const blocks: Block[] = [
    {
      type: 'stat',
      id: 'status',
      label: 'Status',
      value: cap(status),
      tone: AGENT_TONE[status],
      span: 1,
    },
    { type: 'stat', id: 'tools', label: 'Tool calls', value: agent.tools, span: 1 },
    { type: 'stat', id: 'elapsed', label: 'Elapsed', value: formatDuration(elapsed), span: 1 },
  ];
  const pairs: { key: string; value: string }[] = [
    { key: 'Task', value: clip(agent.label, 300) },
    { key: 'Type', value: clip(agent.type, 100) },
    { key: 'Agent id', value: agent.short },
  ];
  if (agent.endedAt === undefined) {
    pairs.push({ key: 'Now', value: clip(agent.activity || 'Starting', 300) });
  } else if (agent.summary) {
    pairs.push({ key: 'Result', value: clip(oneLine(agent.summary), 300) });
  }
  const stop = agent.stopped ?? session.stopped;
  if (stop) pairs.push({ key: 'Stop', value: `Requested by ${stop.by.displayName}` });
  if (agent.approvals > 0) pairs.push({ key: 'Approvals pending', value: String(agent.approvals) });
  if (agent.denied > 0) pairs.push({ key: 'Refused calls', value: String(agent.denied) });
  pairs.push({ key: 'Session', value: `${session.folder || 'session'} · ${session.short}` });
  pairs.push({ key: 'Started', value: stamp(agent.startedAt) });
  blocks.push({ type: 'kv', id: 'info', pairs });

  if (agent.endedAt === undefined && !agent.stopped && !session.stopped) {
    blocks.push({
      type: 'actions',
      id: 'controls',
      buttons: [
        {
          id: STOP_BUTTON,
          label: 'Stop agent',
          style: 'danger',
          confirm: {
            title: 'Stop this subagent?',
            body: 'Its next tool call is refused with a message telling it to stop.',
            confirmLabel: 'Stop agent',
          },
          requiredPermission: options.permission,
        },
      ],
    });
  }
  return { title: clip(`Subagent: ${agent.label}`, 100), blocks };
}
