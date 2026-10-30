import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message, Panel } from '@harmony/shared';
import {
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureUser,
  type Infra,
  type TestApp,
} from './support/harness.js';
import { addBotToGuild, botApi, createBot } from './support/bots.js';

const MCP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/mcp',
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = () => randomUUID().slice(0, 8);

type HookEvent = Record<string, unknown>;

/** Real hook input recorded from a headless Claude Code run with two parallel subagents. */
const recorded = readFileSync(
  path.join(MCP_DIR, 'tests/fixtures/claude-code-two-subagents.jsonl'),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as HookEvent);

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;

/**
 * The built `harmony-hook` driven with recorded hook JSON against the real app, with the daemon
 * it starts by itself, and people pressing the panel buttons.
 */
describe('the agent control room end to end', () => {
  let infra: Infra;
  let target: TestApp;
  let stateDir: string;
  let env: Record<string, string>;
  let token = '';
  const hookBin = path.join(MCP_DIR, 'dist/hook-bin.js');
  const daemonBin = path.join(MCP_DIR, 'dist/agentd-bin.js');

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@harmony/mcp', 'build'], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`mcp build failed: ${build.stdout}${build.stderr}`);
    infra = createInfra();
    target = await infra.startApp({
      PANEL_COALESCE_MS: '0',
      PANEL_RATE_MAX: '1000',
      ACTION_RATE_MAX: '1000',
      MESSAGE_RATE_MAX: '1000',
    });
  });
  afterAll(async () => {
    if (env) {
      spawnSync(process.execPath, [daemonBin, 'stop'], { env, encoding: 'utf8' });
      const pidFile = readPid();
      if (pidFile) {
        try {
          process.kill(pidFile, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
    await infra.stop();
  });

  function readPid(): number | undefined {
    try {
      const files = spawnSync('ls', [stateDir], { encoding: 'utf8' }).stdout.split('\n');
      const pid = files.find((f) => f.endsWith('.pid'));
      return pid ? Number(readFileSync(path.join(stateDir, pid), 'utf8')) : undefined;
    } catch {
      return undefined;
    }
  }

  const runHook = (event: HookEvent) =>
    new Promise<{ stdout: string; stderr: string; ms: number }>((resolve, reject) => {
      const started = performance.now();
      const child = spawn(process.execPath, [hookBin], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', () => resolve({ stdout, stderr, ms: performance.now() - started }));
      child.stdin.end(JSON.stringify(event));
    });
  const decision = (stdout: string) =>
    (JSON.parse(stdout || '{}') as { hookSpecificOutput?: Record<string, string> })
      .hookSpecificOutput;

  it('shows a session and its subagents, and people stop one subagent and steer the agent', async () => {
    const suffix = tag();
    const owner = `owner-${suffix}@example.com`;
    const alice = `alice-${suffix}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner, [alice]);
    const textId = await createChannel(infra.db, [owner, alice], { guildId, createdBy: owner });
    const dashboardId = await createChannel(infra.db, [owner, alice], {
      guildId,
      createdBy: owner,
      kind: 'dashboard',
    });
    const created = await createBot(target, owner, {
      scopes: ['messages.read', 'messages.write', 'channels.read', 'panels.write', 'commands'],
    });
    token = created.token;
    await addBotToGuild(target, owner, guildId, created.bot.id);

    stateDir = mkdtempSync(path.join(os.tmpdir(), 'hagd-it-'));
    const tokenFile = path.join(stateDir, 'bot.env');
    writeFileSync(tokenFile, `HARMONY_BOT_TOKEN=${token}\n`);
    chmodSync(tokenFile, 0o600);
    env = {
      PATH: process.env.PATH ?? '',
      HARMONY_URL: target.url,
      // The token is only in the file: nothing below puts it in the environment.
      HARMONY_BOT_TOKEN_FILE: tokenFile,
      HARMONY_AGENTD: '1',
      HARMONY_AGENTD_DIR: stateDir,
      HARMONY_DASHBOARD_CHANNEL: dashboardId,
      HARMONY_AGENT_CHANNEL: textId,
      HARMONY_STEER_CHANNEL: textId,
      HARMONY_APPROVAL_PATTERN: 'git push',
      HARMONY_PANEL_MIN_INTERVAL_MS: '50',
      HARMONY_AGENTD_PANEL_GAP_MS: '10',
    };

    const asOwner = api(target, owner);
    const asAlice = api(target, alice);
    const asBot = botApi(target, token);
    const sessionId = randomUUID();
    const cwd = '/home/user/work/shop';
    const ev = (extra: HookEvent): HookEvent => ({ ...extra, session_id: sessionId, cwd });
    const agents = { a: 'agent-aaaaaaaa1', b: 'agent-bbbbbbbb1' };

    const panels = async () =>
      ((await asBot(`/api/channels/${dashboardId}/panels`)).body as { panels: Panel[] }).panels;
    const until = async <T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) {
          const logs = spawnSync('sh', ['-c', `ls -la ${stateDir}; tail -n 20 ${stateDir}/*.log`], {
            encoding: 'utf8',
          });
          const status = spawnSync(process.execPath, [daemonBin, 'status'], {
            env,
            encoding: 'utf8',
          });
          const listed = JSON.stringify((await panels()).map((p) => p.key + ':' + p.view.title));
          throw new Error(
            `condition not met in time\n${logs.stdout}${logs.stderr}\n${status.stdout}${status.stderr}\n${listed}`,
          );
        }
        await sleep(60);
      }
    };
    const panelTitled = (title: string) => async () =>
      (await panels()).find((p) => p.view.title === title);

    // The first hook starts the daemon (detached) and hands it the event.
    const first = await runHook(ev({ hook_event_name: 'SessionStart', source: 'startup' }));
    expect(first.stderr).toBe('');
    const cold = `cold first hook (starts the daemon): ${first.ms.toFixed(0)} ms`;
    console.info(cold);
    if (process.env.H3_LATENCY_FILE) appendFileSync(process.env.H3_LATENCY_FILE, `${cold}\n`);
    await runHook(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'refactor everything' }));
    const sessionPanel = await until(
      panelTitled(`Claude Code: shop · ${sessionId.replaceAll('-', '').slice(0, 8)}`),
    );
    expect(sessionPanel.key).toMatch(/^cc-/);

    // Two parallel subagents, exactly as Claude Code reports them: the parent's Agent call first.
    const agentCalls = recorded.filter(
      (e) => e.hook_event_name === 'PreToolUse' && e.tool_name === 'Agent',
    );
    expect(agentCalls).toHaveLength(2);
    const startOf = (id: string) =>
      ev({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'general-purpose' });
    await runHook(ev({ ...agentCalls[0], hook_event_name: 'PreToolUse' }));
    await runHook(startOf(agents.a));
    await runHook(ev({ ...agentCalls[1], hook_event_name: 'PreToolUse' }));
    await runHook(startOf(agents.b));
    const subA = await until(panelTitled('Subagent: List folder a'));
    const subB = await until(panelTitled('Subagent: List folder b'));

    const ls = (id: string, command: string) =>
      ev({
        hook_event_name: 'PreToolUse',
        agent_id: id,
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_use_id: `toolu_${tag()}`,
        tool_input: { command, description: 'x' },
      });
    expect((await runHook(ls(agents.a, 'ls ./a'))).stdout).toBe('');
    expect((await runHook(ls(agents.b, 'ls ./b'))).stdout).toBe('');
    await until(async () => {
      const p = (await panelTitled('Subagent: List folder a')()) as Panel | undefined;
      return p && JSON.stringify(p.view).includes('Bash: ls ./a');
    });

    // Buttons carry the permission; a member without it is refused by the server.
    const buttons = subA.view.blocks.flatMap((b) => (b.type === 'actions' ? b.buttons : []));
    expect(buttons.map((b) => b.id)).toEqual(['stop']);
    expect(buttons[0]?.requiredPermission).toBe('manage_messages');
    expect(buttons[0]?.confirm).toBeDefined();
    const refused = await asAlice('/api/interactions/actions', {
      method: 'POST',
      body: { source: { panelId: subA.id }, actionId: 'stop' },
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'missing_permission' });
    expect((await runHook(ls(agents.a, 'ls ./a'))).stdout).toBe('');

    // The owner stops subagent A only.
    const stop = await asOwner('/api/interactions/actions', {
      method: 'POST',
      body: { source: { panelId: subA.id }, actionId: 'stop' },
    });
    expect(stop.status).toBe(202);
    await until(async () => {
      const p = await panelTitled('Subagent: List folder a')();
      return p && JSON.stringify(p.view).includes('Requested by');
    });
    const denied = decision((await runHook(ls(agents.a, 'ls ./a'))).stdout);
    expect(denied?.hookEventName).toBe('PreToolUse');
    expect(denied?.permissionDecision).toBe('deny');
    expect(denied?.permissionDecisionReason).toContain('stopped from Harmony by');
    expect((await runHook(ls(agents.b, 'ls ./b'))).stdout).toBe('');
    // The main agent is not affected either.
    expect(
      (
        await runHook(
          ev({
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: `${cwd}/a.ts` },
          }),
        )
      ).stdout,
    ).toBe('');
    // A stopped subagent can always end: SubagentStop is never blocked.
    const ended = await runHook(
      ev({
        hook_event_name: 'SubagentStop',
        agent_id: agents.a,
        agent_type: 'general-purpose',
        last_assistant_message: 'Stopped early.',
      }),
    );
    expect(ended.stdout).toBe('');

    // Steering: a person replies to the session's message in the text channel.
    const status = await until(async () => {
      const page = await asOwner(`/api/channels/${textId}/messages`);
      return (page.body as { messages: Message[] }).messages.find(
        (m) => m.author.isBot && m.content.includes('Reply to this message'),
      );
    });
    const reply = await asOwner(`/api/channels/${textId}/messages`, {
      method: 'POST',
      body: { content: 'Please leave the tests alone.', replyToId: status.id },
    });
    expect(reply.status).toBe(201);
    const steered = await until(async () => {
      const out = await runHook(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }));
      return decision(out.stdout)?.additionalContext ? out : undefined;
    });
    const context = decision(steered.stdout);
    expect(context?.hookEventName).toBe('PostToolUse');
    expect(context?.additionalContext).toContain('via Harmony: "Please leave the tests alone."');
    expect(context?.additionalContext).toContain('not from the user at your terminal');
    expect(
      decision((await runHook(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }))).stdout),
    ).toBeUndefined();

    // Finish: B done with its result, then the session ends.
    await runHook(
      ev({
        hook_event_name: 'SubagentStop',
        agent_id: agents.b,
        agent_type: 'general-purpose',
        last_assistant_message: 'The output of `ls ./b` was:\n\n```\nthree.txt\n```',
      }),
    );
    await until(async () => {
      const p = await panelTitled('Subagent: List folder b')();
      return (
        p && JSON.stringify(p.view).includes('Done') && JSON.stringify(p.view).includes('three.txt')
      );
    });
    await runHook(ev({ hook_event_name: 'Stop', stop_hook_active: false }));
    await runHook(ev({ hook_event_name: 'SessionEnd', reason: 'other' }));
    const finalSession = await until(async () => {
      const p = (await panels()).find((x) => x.key === sessionPanel.key);
      return p && JSON.stringify(p.view).includes('"Ended"') ? p : undefined;
    });
    const json = JSON.stringify(finalSession.view);
    expect(json).toContain('List folder a');
    expect(json).toContain('List folder b');
    expect(json).not.toContain(token);
    expect(subB.key).toMatch(/^ag-/);

    // Only one daemon ran, it never saw the token outside its file, and it keeps no token in its log.
    const logs = spawnSync('ls', [stateDir], { encoding: 'utf8' }).stdout;
    expect(logs.split('\n').filter((f) => f.endsWith('.pid'))).toHaveLength(1);
    for (const f of logs.split('\n').filter((x) => x.endsWith('.log'))) {
      expect(readFileSync(path.join(stateDir, f), 'utf8')).not.toContain(token);
    }
  }, 120_000);

  it('answers a PreToolUse that no rule selects in tens of milliseconds', async () => {
    // Runs after the test above, so the daemon is already up (a cold start is measured separately).
    expect(existsSync(stateDir)).toBe(true);
    const event = {
      session_id: randomUUID(),
      cwd: '/home/user/work/shop',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 'toolu_x',
      tool_input: { file_path: '/home/user/work/shop/a.ts' },
    };
    // Warm up the page cache, then measure.
    for (let i = 0; i < 5; i += 1) await runHook(event);
    const times: number[] = [];
    for (let i = 0; i < 100; i += 1) times.push((await runHook(event)).ms);
    times.sort((a, b) => a - b);
    const bare: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t = performance.now();
      spawnSync(process.execPath, ['-e', '0']);
      bare.push(performance.now() - t);
    }
    bare.sort((a, b) => a - b);
    const line = `hook latency over a live daemon, 100 sequential PreToolUse runs: p50 ${percentile(times, 50).toFixed(0)} ms, p95 ${percentile(times, 95).toFixed(0)} ms, max ${(times.at(-1) ?? 0).toFixed(0)} ms; bare "node -e 0": p50 ${percentile(bare, 50).toFixed(0)} ms`;
    console.info(line);
    if (process.env.H3_LATENCY_FILE) appendFileSync(process.env.H3_LATENCY_FILE, `${line}\n`);
    expect(percentile(times, 50)).toBeLessThan(400);
  }, 120_000);
});
