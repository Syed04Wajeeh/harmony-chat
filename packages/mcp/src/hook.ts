import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Approvals, personOf, type Risk } from './approvals.js';
import { HarmonyClient } from './client.js';
import { ConfigError } from './config.js';
import { defuseMassMentions } from './format.js';
import { RunManager, type Run, type RunSnapshot } from './runs.js';
import { ChannelResolver } from './tools.js';

/**
 * What Claude Code sends a hook on stdin. Only the fields used here are listed; the rest are
 * ignored. See https://code.claude.com/docs/en/hooks (common fields, Notification, Stop,
 * PreToolUse, UserPromptSubmit, SessionStart).
 */
export const HookInput = z
  .object({
    session_id: z.string().default('unknown'),
    hook_event_name: z.string(),
    cwd: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
    title: z.string().optional(),
    notification_type: z.string().optional(),
    prompt: z.string().optional(),
    last_assistant_message: z.string().optional(),
    stop_hook_active: z.boolean().optional(),
  })
  .loose();
export type HookInput = z.infer<typeof HookInput>;

export interface HookConfig {
  url: string;
  token: string;
  channel: string;
  /** Where the optional run panel lives (a dashboard channel works); defaults to `channel`. */
  runChannel: string;
  /** Tool calls whose subject matches this ask for approval. Unset: none do. */
  approvalPattern: RegExp | undefined;
  approvalSeconds: number;
  /** What a timeout means: refuse (`deny`) or hand back to Claude Code's own prompt (`ask`). */
  onTimeout: 'deny' | 'ask';
  risk: Risk;
  permission: string;
  /** Hard ceiling for the whole hook run; Claude Code is never kept waiting longer. */
  maxSeconds: number;
  /** Keep a run panel for the session (needs the panels.write scope). */
  runPanel: boolean;
  /** Put prompt and reply text in the channel. Off by default: they can hold code and secrets. */
  includeText: boolean;
  stateDir: string;
}

const intFrom = (raw: string | undefined, fallback: number, name: string, min = 1): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} must be an integer of at least ${String(min)}.`);
  }
  return value;
};

export function loadHookConfig(env: Record<string, string | undefined>): HookConfig {
  const token = env.HARMONY_BOT_TOKEN?.trim();
  if (!token || !/^hb_\d+_\S+$/.test(token)) {
    throw new ConfigError('Set HARMONY_BOT_TOKEN to a Harmony bot token (hb_<botId>_<secret>).');
  }
  const channel = (env.HARMONY_AGENT_CHANNEL ?? env.HARMONY_DEFAULT_CHANNEL)?.trim();
  if (!channel) throw new ConfigError('Set HARMONY_AGENT_CHANNEL to a channel id or #name.');
  let approvalPattern: RegExp | undefined;
  const rawPattern = env.HARMONY_APPROVAL_PATTERN;
  if (rawPattern && rawPattern.trim() !== '') {
    try {
      approvalPattern = new RegExp(rawPattern);
    } catch {
      throw new ConfigError('HARMONY_APPROVAL_PATTERN is not a valid regular expression.');
    }
  }
  const approvalSeconds = intFrom(
    env.HARMONY_APPROVAL_TIMEOUT_SECONDS,
    300,
    'HARMONY_APPROVAL_TIMEOUT_SECONDS',
  );
  if (approvalSeconds > 3600) {
    throw new ConfigError('HARMONY_APPROVAL_TIMEOUT_SECONDS is at most 3600.');
  }
  const onTimeout = env.HARMONY_APPROVAL_ON_TIMEOUT?.trim() || 'deny';
  if (onTimeout !== 'deny' && onTimeout !== 'ask') {
    throw new ConfigError('HARMONY_APPROVAL_ON_TIMEOUT must be "deny" or "ask".');
  }
  const risk = env.HARMONY_APPROVAL_RISK?.trim() || 'medium';
  if (risk !== 'low' && risk !== 'medium' && risk !== 'high') {
    throw new ConfigError('HARMONY_APPROVAL_RISK must be low, medium or high.');
  }
  return {
    url: (env.HARMONY_URL?.trim() || 'http://127.0.0.1:8471').replace(/\/+$/, ''),
    token,
    channel,
    runChannel: env.HARMONY_HOOK_RUN_CHANNEL?.trim() || channel,
    approvalPattern,
    approvalSeconds,
    onTimeout,
    risk,
    permission: env.HARMONY_APPROVAL_PERMISSION?.trim() || 'manage_messages',
    maxSeconds: intFrom(
      env.HARMONY_HOOK_MAX_SECONDS,
      approvalSeconds + 20,
      'HARMONY_HOOK_MAX_SECONDS',
    ),
    runPanel: env.HARMONY_HOOK_RUN === '1',
    includeText: env.HARMONY_HOOK_INCLUDE_TEXT === '1',
    stateDir: env.HARMONY_HOOK_STATE_DIR?.trim() || path.join(os.tmpdir(), 'harmony-hook'),
  };
}

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** The JSON Claude Code reads from a PreToolUse hook's stdout. */
export function preToolUseOutput(decision: PermissionDecision, reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

/** The text a pattern is matched against: a Bash command, or the tool name and its input. */
export function subjectOf(input: HookInput): string {
  const command = input.tool_input?.command;
  if (input.tool_name === 'Bash' && typeof command === 'string') return command;
  return `${input.tool_name ?? ''} ${JSON.stringify(input.tool_input ?? {}).slice(0, 2000)}`;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Breaks `<@id>` mention tokens: hook text comes from a model and must not page people. */
const noMentions = (text: string) => defuseMassMentions(text).replaceAll('<@', '<​@');

/** A code fence long enough that the text inside cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

export function approvalDetails(input: HookInput): string {
  const subject = input.tool_name === 'Bash' ? subjectOf(input) : subjectOf(input).trim();
  const where = input.cwd ? path.basename(input.cwd) : undefined;
  return noMentions(
    [
      `Tool: \`${input.tool_name ?? '?'}\`${where ? ` · folder: \`${where.replaceAll('`', '')}\`` : ''}`,
      fenced(clip(subject, 1200)),
      `Claude Code session \`${input.session_id.slice(0, 8)}\``,
    ].join('\n\n'),
  );
}

export interface HookResult {
  /** What to print on stdout, if anything. */
  stdout?: string;
}

export interface HookDeps {
  client?: HarmonyClient;
  now?: () => number;
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

async function loadRun(config: HookConfig, input: HookInput): Promise<RunSnapshot | undefined> {
  try {
    const raw = await readFile(
      path.join(config.stateDir, `${safeName(input.session_id)}.json`),
      'utf8',
    );
    return JSON.parse(raw) as RunSnapshot;
  } catch {
    return undefined;
  }
}

async function saveRun(config: HookConfig, input: HookInput, run: RunSnapshot): Promise<void> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.stateDir, `${safeName(input.session_id)}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(run), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/**
 * One hook event. PreToolUse may ask people to approve (and answers allow, deny or ask);
 * Notification and Stop post to the channel; SessionStart and UserPromptSubmit keep the optional
 * run panel current. Throws on a failure; `runHook` turns that into the fail-safe answer.
 */
export async function handleHook(
  input: HookInput,
  config: HookConfig,
  deps: HookDeps = {},
): Promise<HookResult> {
  const client = deps.client ?? new HarmonyClient({ url: config.url, token: config.token });
  const event = input.hook_event_name;
  const wantsApproval =
    event === 'PreToolUse' && config.approvalPattern?.test(subjectOf(input)) === true;
  if (
    !wantsApproval &&
    !['Notification', 'Stop', 'SessionStart', 'UserPromptSubmit'].includes(event)
  ) {
    return {};
  }

  const resolver = new ChannelResolver(client, undefined);
  const channelId = await resolver.resolve(config.channel);
  const runs = new RunManager(client, {
    minIntervalMs: 0,
    permission: config.permission,
    cancellable: false,
  });
  const approvals = new Approvals(client);
  client.setInteractionHandler((interaction) =>
    interaction.type === 'action' && interaction.action.source.kind === 'message'
      ? approvals.handleAction(
          interaction.action.source.messageId,
          interaction.action.id,
          personOf(interaction),
        )
      : { type: 'message', content: 'Nothing to do here.', ephemeral: true },
  );

  // The run panel is a nicety: it never changes what the hook answers.
  let run: Run | undefined;
  const track = async (change: (run: Run) => void | Promise<void>, create = true) => {
    if (!config.runPanel) return;
    try {
      const runChannelId = await resolver.resolve(config.runChannel, ['dashboard', 'text']);
      const saved = await loadRun(config, input);
      if (saved && saved.channelId === runChannelId && saved.endedAt === undefined) {
        run = runs.restore(saved);
      } else if (create) {
        const title = `Claude Code${input.cwd ? ` in ${path.basename(input.cwd)}` : ''}`;
        run = await runs.start({ channelId: runChannelId, title });
      }
      if (!run) return;
      await change(run);
      await runs.flush(run);
      // A finished turn is done with its file; the next prompt starts a new run.
      if (run.endedAt === undefined) await saveRun(config, input, runs.snapshot(run));
      else
        await rm(path.join(config.stateDir, `${safeName(input.session_id)}.json`), { force: true });
    } catch {
      // Panel trouble (scope, limit, disk) is not a reason to disturb Claude Code.
    }
  };

  switch (event) {
    case 'SessionStart': {
      await track((r) => runs.update(r, { step: 'Session started' }));
      return {};
    }
    case 'UserPromptSubmit': {
      const step =
        config.includeText && input.prompt
          ? clip(input.prompt.replace(/\s+/g, ' '), 120)
          : 'Working on a prompt';
      await track((r) => runs.update(r, { step, status: 'running' }));
      return {};
    }
    case 'Notification': {
      const text = clip(input.message ?? 'Claude Code needs your attention.', 800);
      await client.sendMessage(channelId, {
        content: noMentions(`**Claude Code needs your input**\n${text}`),
      });
      await track((r) => runs.update(r, { status: 'waiting_reply', note: clip(text, 120) }), false);
      return {};
    }
    case 'Stop': {
      const tail =
        config.includeText && input.last_assistant_message
          ? `\n${clip(input.last_assistant_message.replace(/\s+/g, ' ').trim(), 300)}`
          : '';
      await client.sendMessage(channelId, {
        content: noMentions(
          `**Claude Code finished** its turn${input.cwd ? ` in \`${path.basename(input.cwd).replaceAll('`', '')}\`` : ''}.${tail}`,
        ),
      });
      await track((r) => runs.finish(r, 'done', 'Turn finished'), false);
      return {};
    }
    case 'PreToolUse': {
      if (!wantsApproval) return {};
      let result;
      try {
        await track((r) =>
          runs.update(r, {
            step: clip(`Approval: ${input.tool_name ?? 'tool'}`, 100),
            status: 'waiting_approval',
          }),
        );
        result = await approvals.request({
          channelId,
          title: clip(`Claude Code wants to run ${input.tool_name ?? 'a tool'}`, 200),
          details: approvalDetails(input),
          risk: config.risk,
          timeoutMs: config.approvalSeconds * 1000,
          requiredPermission: config.permission,
        });
      } finally {
        await track((r) => runs.update(r, { status: 'running' }), false);
      }
      const who = result.by ? `${result.by.displayName} (@${result.by.login})` : 'someone';
      if (result.decision === 'approved') {
        return { stdout: preToolUseOutput('allow', `Approved in Harmony by ${who}.`) };
      }
      if (result.decision === 'denied') {
        return { stdout: preToolUseOutput('deny', `Denied in Harmony by ${who}.`) };
      }
      return {
        stdout: preToolUseOutput(
          config.onTimeout,
          `No decision in Harmony within ${String(config.approvalSeconds)}s${config.onTimeout === 'ask' ? '; asking in the terminal.' : '; denied.'}`,
        ),
      };
    }
    default:
      return {};
  }
}

/**
 * The entry point's logic: parse, handle, and never fail loudly. A PreToolUse hook that cannot
 * do its job answers `ask`, which is Claude Code's normal permission prompt; every other event
 * answers nothing. A hard timeout makes the same fallback if anything stalls.
 */
export async function runHook(
  rawInput: string,
  env: Record<string, string | undefined>,
  deps: HookDeps = {},
): Promise<{ stdout?: string; log?: string }> {
  let input: HookInput;
  try {
    input = HookInput.parse(JSON.parse(rawInput));
  } catch {
    return { log: 'harmony-hook: stdin is not a hook event; ignoring it.' };
  }
  const fallback = (why: string): { stdout?: string; log: string } => ({
    ...(input.hook_event_name === 'PreToolUse' && {
      stdout: preToolUseOutput(
        'ask',
        `Harmony approval unavailable (${why}); asking in the terminal.`,
      ),
    }),
    log: `harmony-hook: ${why}`,
  });

  // Only tool calls the pattern selects ever need an answer; an unset pattern selects none.
  let rejected: string | undefined;
  if (input.hook_event_name === 'PreToolUse') {
    const rawPattern = env.HARMONY_APPROVAL_PATTERN;
    if (!rawPattern || rawPattern.trim() === '') return {};
    try {
      if (!new RegExp(rawPattern).test(subjectOf(input))) return {};
    } catch {
      rejected = 'HARMONY_APPROVAL_PATTERN is not a valid regular expression';
    }
  }
  if (rejected) return fallback(rejected);

  let config: HookConfig;
  try {
    config = loadHookConfig(env);
  } catch (error) {
    // Not configured: only an event that would have asked needs an answer, and then it is "ask".
    return fallback(error instanceof Error ? error.message : 'bad configuration');
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), config.maxSeconds * 1000);
  });
  try {
    const outcome = await Promise.race([handleHook(input, config, deps), timeout]);
    if (outcome === 'timeout') return fallback(`took longer than ${String(config.maxSeconds)}s`);
    return outcome;
  } catch (error) {
    const text = error instanceof Error ? error.message : 'error';
    return fallback(text.replaceAll(config.token, '[token]'));
  } finally {
    clearTimeout(timer);
  }
}
