import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PanelView } from '@harmony/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callDaemon, ensureDaemon, trimEvent, viaDaemon } from '../src/agentd-client.js';
import { resolveToken } from '../src/agentd-config.js';
import {
  AlreadyRunning,
  loadAgentdConfig,
  startAgentd,
  type Agentd,
  type AgentdConfig,
} from '../src/agentd.js';
import type { ControlEvent } from '../src/control.js';
import { ADA, BEN, FakeHarmony, OTHER_BOT, TOKEN } from './fake-harmony.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(here, 'fixtures/claude-code-two-subagents.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => trimEvent(JSON.parse(line) as Record<string, unknown>) as unknown as ControlEvent);

const S = 'sess-1111-2222-3333';
const ev = (extra: Partial<ControlEvent> & { hook_event_name: string }): ControlEvent => ({
  session_id: S,
  cwd: '/work/shop',
  ...extra,
});
const spawnCall = (description: string, id: string) =>
  ev({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: id,
    tool_input: { description, subagent_type: 'general-purpose' },
  });
const bash = (command: string, agent?: string) =>
  ev({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    ...(agent && { agent_id: agent, agent_type: 'general-purpose' }),
  });

const permissionOf = (output: string | undefined) =>
  (JSON.parse(output ?? '{}') as { hookSpecificOutput?: Record<string, string> })
    .hookSpecificOutput;

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'hagd-'));
}

describe('harmony-agentd', () => {
  let fake: FakeHarmony;
  let dir: string;
  let daemon: Agentd | undefined;

  beforeAll(async () => {
    fake = await FakeHarmony.start();
  });
  afterAll(async () => {
    await fake.stop();
  });
  beforeEach(() => {
    fake.messages.clear();
    fake.panels.clear();
    fake.panelWrites.length = 0;
    fake.requests.length = 0;
    dir = tmpDir();
  });
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  const configFor = (extra: Record<string, string> = {}): AgentdConfig =>
    loadAgentdConfig({
      HARMONY_URL: fake.url,
      HARMONY_BOT_TOKEN: TOKEN,
      HARMONY_DASHBOARD_CHANNEL: '12',
      HARMONY_AGENT_CHANNEL: '11',
      HARMONY_STEER_CHANNEL: '11',
      HARMONY_APPROVAL_PATTERN: 'git push|rm -rf',
      HARMONY_APPROVAL_TIMEOUT_SECONDS: '30',
      HARMONY_PANEL_MIN_INTERVAL_MS: '20',
      HARMONY_AGENTD_PANEL_GAP_MS: '0',
      HARMONY_AGENTD_PAUSE_SECONDS: '2',
      HARMONY_AGENTD_DIR: dir,
      ...extra,
    });
  const start = async (extra: Record<string, string> = {}, noSocket = true) => {
    daemon = await startAgentd(configFor(extra), { noSocket, noPidfile: noSocket });
    return daemon;
  };

  const panelView = (key: string) => fake.panels.get(`12/${key}`)?.view as PanelView | undefined;
  const text = (view: PanelView | undefined) => JSON.stringify(view ?? {});
  const sessionPanelKey = 'cc-sess1111';
  const agentPanels = () => [...fake.panels.keys()].filter((k) => k.startsWith('12/ag-'));
  const flush = async (d: Agentd) => {
    await sleep(30);
    await d.sync.flush();
  };

  async function twoSubagents(d: Agentd) {
    await d.handle(ev({ hook_event_name: 'SessionStart', source: 'startup' }));
    await d.handle(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }));
    await d.handle(spawnCall('B+C worker', 't1'));
    await d.handle(
      ev({
        hook_event_name: 'SubagentStart',
        agent_id: 'bbbbbbbb1',
        agent_type: 'general-purpose',
      }),
    );
    await d.handle(spawnCall('D worker', 't2'));
    await d.handle(
      ev({
        hook_event_name: 'SubagentStart',
        agent_id: 'dddddddd1',
        agent_type: 'general-purpose',
      }),
    );
    await flush(d);
  }

  it('shows a session panel and one panel per subagent, with what each is doing', async () => {
    const d = await start();
    await twoSubagents(d);
    await d.handle(bash('pnpm test:unit', 'bbbbbbbb1'));
    await d.handle(
      ev({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        agent_id: 'dddddddd1',
        agent_type: 'general-purpose',
        tool_input: { file_path: '/work/shop/apps/server/src/x.ts' },
      }),
    );
    await flush(d);
    const session = text(panelView(sessionPanelKey));
    expect(session).toContain('Claude Code: shop');
    expect(session).toContain('2 running');
    expect(session).toContain('B+C worker');
    expect(agentPanels()).toHaveLength(2);
    const b = text(panelView('ag-sess1111-bbbbbbbb'));
    expect(b).toContain('Subagent: B+C worker');
    expect(b).toContain('Bash: pnpm test:unit');
    expect(text(panelView('ag-sess1111-dddddddd'))).toContain('Edit apps/server/src/x.ts');

    await d.handle(
      ev({
        hook_event_name: 'SubagentStop',
        agent_id: 'bbbbbbbb1',
        agent_type: 'general-purpose',
        last_assistant_message: '```\nall green\n```\nDone with B and C.',
      }),
    );
    await flush(d);
    const done = text(panelView('ag-sess1111-bbbbbbbb'));
    expect(done).toContain('Done');
    expect(done).toContain('all green');
    expect(done).not.toContain('"actions"');
    expect(text(panelView(sessionPanelKey))).toContain('1 running');
  });

  it('never puts secrets or file contents on a panel', async () => {
    const d = await start();
    await twoSubagents(d);
    await d.handle(
      bash('deploy --token hb_9_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG now', 'bbbbbbbb1'),
    );
    await d.handle(bash('cat .env', 'dddddddd1'));
    await flush(d);
    expect(text(panelView('ag-sess1111-dddddddd'))).toContain('command withheld');
    await d.handle(
      ev({
        hook_event_name: 'SubagentStop',
        agent_id: 'dddddddd1',
        agent_type: 'general-purpose',
        last_assistant_message: 'key is sk-ant-api03-abcdefghijklmnopqrstuv ok',
      }),
    );
    await flush(d);
    const all = [...fake.panels.values()].map((p) => JSON.stringify(p.view)).join('\n');
    expect(all).not.toContain('hb_9_');
    expect(all).not.toContain('sk-ant');
  });

  it('Stop on one subagent denies its next call and leaves the other alone', async () => {
    const d = await start();
    await twoSubagents(d);
    const view = panelView('ag-sess1111-bbbbbbbb');
    const button = JSON.stringify(view);
    expect(button).toContain('"requiredPermission":"manage_messages"');
    expect(button).toContain('"confirm"');

    const answer = await fake.click(
      { panelKey: 'ag-sess1111-bbbbbbbb', channelId: '12' },
      'stop',
      ADA,
    );
    expect(answer).toMatchObject({ response: { type: 'message', ephemeral: true } });

    const denied = permissionOf((await d.handle(bash('ls', 'bbbbbbbb1'))).output);
    expect(denied?.permissionDecision).toBe('deny');
    expect(denied?.permissionDecisionReason).toContain('stopped from Harmony by Ada');
    expect((await d.handle(bash('ls', 'dddddddd1'))).output).toBeUndefined();
    expect((await d.handle(bash('ls'))).output).toBeUndefined();

    // Stop and SubagentStop are never blocked: a stopped agent can always end.
    const end = await d.handle(
      ev({ hook_event_name: 'SubagentStop', agent_id: 'bbbbbbbb1', agent_type: 'general-purpose' }),
    );
    expect(end).toEqual({});
    await flush(d);
    expect(text(panelView('ag-sess1111-bbbbbbbb'))).toContain('Stopped');
  });

  it('Stop on the session denies the main agent and every subagent, and aborts a pending approval', async () => {
    const d = await start();
    await twoSubagents(d);
    const pending = d.handle(bash('git push origin main', 'dddddddd1'));
    const asked = await until(() => [...(fake.messages.get('11') ?? [])].find((m) => m.components));
    expect(asked.content).toContain("Subagent 'D worker' wants to run");

    await fake.click({ panelKey: sessionPanelKey, channelId: '12' }, 'stop', ADA);
    const result = permissionOf((await pending).output);
    expect(result?.permissionDecision).toBe('deny');
    for (const agent of ['bbbbbbbb1', 'dddddddd1', undefined]) {
      expect(permissionOf((await d.handle(bash('ls', agent))).output)?.permissionDecision).toBe(
        'deny',
      );
    }
    // The approval message no longer offers buttons.
    await until(() =>
      [...(fake.messages.get('11') ?? [])].find((m) => m.id === asked.id && !m.components),
    );
  });

  it('approvals name the agent that asked and hide secret-looking parts', async () => {
    const d = await start();
    await twoSubagents(d);
    const pending = d.handle(bash('git push https://bob:s3cret@host.example/r.git', 'bbbbbbbb1'));
    const asked = await until(() => [...(fake.messages.get('11') ?? [])].find((m) => m.components));
    expect(asked.content).toContain(
      "Subagent 'B+C worker' wants to run: git push https://[redacted]@host.example",
    );
    expect(asked.content).toContain('general-purpose');
    expect(asked.content).not.toContain('s3cret');
    const click = await fake.click({ messageId: asked.id }, 'approve', ADA);
    expect(click).toMatchObject({ response: { type: 'message' } });
    const result = permissionOf((await pending).output);
    expect(result?.permissionDecision).toBe('allow');
    expect(result?.permissionDecisionReason).toContain('Ada');
  });

  it('Pause holds tool calls until Resume, and gives up with a clear refusal', async () => {
    const d = await start();
    await twoSubagents(d);
    await fake.click({ panelKey: sessionPanelKey, channelId: '12' }, 'pause', ADA);
    let acked = 0;
    const held = d.handle(bash('ls', 'dddddddd1'), () => (acked += 1));
    let settled = false;
    void held.then(() => (settled = true));
    await sleep(150);
    expect(settled).toBe(false);
    expect(acked).toBe(1);
    await flush(d);
    expect(text(panelView(sessionPanelKey))).toContain('Paused');
    expect(text(panelView(sessionPanelKey))).toContain('"Resume"');
    await fake.click({ panelKey: sessionPanelKey, channelId: '12' }, 'resume', ADA);
    expect((await held).output).toBeUndefined();

    await fake.click({ panelKey: sessionPanelKey, channelId: '12' }, 'pause', ADA);
    const slow = startShortPause();
    const gaveUp = permissionOf((await slow.handle(bash('ls'))).output);
    expect(gaveUp?.permissionDecision).toBe('deny');
    expect(gaveUp?.permissionDecisionReason).toContain('paused from Harmony by Ada');
  });

  function startShortPause(): Agentd {
    // The session already paused above; a second daemon would not know it, so shorten this one.
    const d = daemon;
    if (!d) throw new Error('no daemon');
    d.config.pauseWaitMs = 80;
    return d;
  }

  it('delivers a person’s reply to the session message as context on the next tool result', async () => {
    const d = await start();
    await twoSubagents(d);
    const status = await until(() =>
      [...(fake.messages.get('11') ?? [])].find((m) => m.content.includes('session `sess1111`')),
    );
    fake.post('11', ADA, 'please keep the diff small', {
      replyTo: { id: status.id, authorId: status.author.id, contentPreview: '', deleted: false },
    });
    await sleep(100);
    const out = permissionOf(
      (await d.handle(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }))).output,
    );
    expect(out?.hookEventName).toBe('PostToolUse');
    expect(out?.additionalContext).toContain(
      'Message from Ada via Harmony: "please keep the diff small"',
    );
    expect(out?.additionalContext).toContain('not from the user at your terminal');
    const again = await d.handle(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }));
    expect(again.output).toBeUndefined();
    expect(text(panelView(sessionPanelKey))).toBeDefined();
  });

  it('a mention with a subagent id steers that subagent only; bots and strangers are ignored', async () => {
    const d = await start({ HARMONY_STEER_USERS: 'ada@example.com' });
    await twoSubagents(d);
    fake.post('11', ADA, '<@900> dddddddd skip the migration');
    fake.post('11', BEN, '<@900> bbbbbbbb ben is not on the list');
    fake.post('11', OTHER_BOT, '<@900> bbbbbbbb a bot talking');
    await sleep(120);
    const toD = permissionOf(
      (
        await d.handle(
          ev({
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            agent_id: 'dddddddd1',
            agent_type: 'general-purpose',
          }),
        )
      ).output,
    );
    expect(toD?.additionalContext).toContain('skip the migration');
    expect(toD?.additionalContext).not.toContain('dddddddd skip');
    const toB = await d.handle(
      ev({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        agent_id: 'bbbbbbbb1',
        agent_type: 'general-purpose',
      }),
    );
    expect(toB.output).toBeUndefined();
    const main = await d.handle(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }));
    expect(main.output).toBeUndefined();
  });

  it('delivers notes at UserPromptSubmit and, once, at Stop', async () => {
    const d = await start();
    await d.handle(ev({ hook_event_name: 'SessionStart' }));
    await until(() => fake.socketCount === 1);
    await sleep(150);
    fake.post('11', ADA, '<@900> remember the changelog');
    await sleep(100);
    const stop = permissionOf(
      (await d.handle(ev({ hook_event_name: 'Stop', stop_hook_active: false }))).output,
    );
    expect(stop?.hookEventName).toBe('Stop');
    expect(stop?.additionalContext).toContain('remember the changelog');
    fake.post('11', ADA, '<@900> and the docs');
    await sleep(100);
    expect(
      (await d.handle(ev({ hook_event_name: 'Stop', stop_hook_active: true }))).output,
    ).toBeUndefined();
    const prompt = permissionOf(
      (await d.handle(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }))).output,
    );
    expect(prompt?.additionalContext).toContain('and the docs');
  });

  it('keeps a long orchestrator run under the panel limit by pruning finished subagents', async () => {
    const d = await start({ HARMONY_AGENTD_KEEP_FINISHED: '3' });
    await d.handle(ev({ hook_event_name: 'SessionStart' }));
    for (let i = 0; i < 25; i += 1) {
      const id = `agent${String(i).padStart(3, '0')}x`;
      await d.handle(spawnCall(`worker ${String(i)}`, `t${String(i)}`));
      await d.handle(
        ev({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'general-purpose' }),
      );
      await d.handle(bash('ls', id));
      await d.handle(
        ev({
          hook_event_name: 'SubagentStop',
          agent_id: id,
          agent_type: 'general-purpose',
          last_assistant_message: 'ok',
        }),
      );
      await sleep(5);
    }
    await flush(d);
    await sleep(100);
    expect(agentPanels().length).toBeLessThanOrEqual(3);
    expect(fake.panels.size).toBeLessThanOrEqual(20);
    expect(text(panelView(sessionPanelKey))).toContain('25 done');
  });

  it('makes room when the channel is full of other panels', async () => {
    fake.panelLimit = 3;
    try {
      const d = await start({ HARMONY_AGENTD_KEEP_FINISHED: '10' });
      await d.handle(ev({ hook_event_name: 'SessionStart' }));
      for (let i = 0; i < 6; i += 1) {
        const id = `agent${String(i)}xxxxx`;
        await d.handle(ev({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 't' }));
        await d.handle(ev({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: 't' }));
        await sleep(30);
      }
      await flush(d);
      await sleep(100);
      expect(fake.panels.size).toBeLessThanOrEqual(3);
      expect(fake.panels.has(`12/${sessionPanelKey}`)).toBe(true);
    } finally {
      fake.panelLimit = 20;
    }
  });

  it('holds one gateway socket while sessions live and none when they are over', async () => {
    const d = await start();
    await d.handle(ev({ hook_event_name: 'SessionStart' }));
    await until(() => fake.socketCount === 1);
    await twoSubagents(d);
    await sleep(100);
    expect(fake.socketCount).toBe(1);
    await d.handle(ev({ hook_event_name: 'SessionEnd', reason: 'other' }));
    await until(() => fake.socketCount === 0, 4000);
    await flush(d);
    expect(text(panelView(sessionPanelKey))).toContain('Ended');
  });

  describe('over the unix socket', () => {
    it('answers hooks, is mode 600, and a second daemon for the same bot refuses to run', async () => {
      const d = await start({}, false);
      const st = await import('node:fs').then((fs) => fs.statSync(d.config.paths.socket));
      expect(st.mode & 0o077).toBe(0);
      const dirMode = await import('node:fs').then((fs) => fs.statSync(d.config.paths.dir).mode);
      expect(dirMode & 0o077).toBe(0);
      const viaSocket = await viaDaemon(
        JSON.stringify({ ...fixture[0], hook_event_name: 'SessionStart' }),
        {
          HARMONY_BOT_TOKEN: TOKEN,
          HARMONY_URL: fake.url,
          HARMONY_AGENTD_DIR: dir,
        },
      );
      expect(viaSocket).toEqual({ handled: true });
      await until(() => d.room.sessions.size === 1);
      await expect(startAgentd(configFor())).rejects.toBeInstanceOf(AlreadyRunning);
    });

    it('exits by itself when idle with no live session', async () => {
      const config = { ...configFor(), idleMs: 120, tickMs: 40 };
      daemon = await startAgentd(config, { noSocket: true, noPidfile: true });
      await Promise.race([
        daemon.closed,
        sleep(2000).then(() => Promise.reject(new Error('still running'))),
      ]);
    });

    it('does not exit while a session is alive', async () => {
      const config = { ...configFor(), idleMs: 100, tickMs: 30 };
      daemon = await startAgentd(config, { noSocket: true, noPidfile: true });
      await daemon.handle(ev({ hook_event_name: 'SessionStart' }));
      let closed = false;
      void daemon.closed.then(() => (closed = true));
      await sleep(400);
      expect(closed).toBe(false);
    });

    it('two hooks starting the daemon at once start exactly one', async () => {
      const env = { HARMONY_BOT_TOKEN: TOKEN, HARMONY_URL: fake.url, HARMONY_AGENTD_DIR: dir };
      const config = configFor();
      let starts = 0;
      const launched: Promise<Agentd | undefined>[] = [];
      const start1 = () => {
        starts += 1;
        launched.push(
          startAgentd(config).catch((error: unknown) => {
            if (error instanceof AlreadyRunning) return undefined;
            throw error;
          }),
        );
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => ensureDaemon(config.paths, env, { start: start1 })),
      );
      expect(results.every(Boolean)).toBe(true);
      expect(starts).toBe(1);
      const daemons = (await Promise.all(launched)).filter((x): x is Agentd => x !== undefined);
      expect(daemons).toHaveLength(1);
      daemon = daemons[0];
    });

    it('even if two daemons are launched anyway, only one survives', async () => {
      const config = configFor();
      const outcomes = await Promise.allSettled([startAgentd(config), startAgentd(config)]);
      const ok = outcomes.filter((o) => o.status === 'fulfilled');
      expect(ok).toHaveLength(1);
      const failed = outcomes.find((o) => o.status === 'rejected');
      expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(AlreadyRunning);
      daemon = ok[0]?.status === 'fulfilled' ? ok[0].value : undefined;
    });
  });
});

describe('the hook when the daemon cannot be used', () => {
  const env = (dirPath: string) => ({
    HARMONY_BOT_TOKEN: TOKEN,
    HARMONY_URL: 'http://127.0.0.1:1',
    HARMONY_AGENTD_DIR: dirPath,
  });
  const event = JSON.stringify({
    session_id: 's',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });

  it('hands the event back to direct mode when nothing listens and none can be started', async () => {
    const result = await viaDaemon(event, env(tmpDir()), {
      start: () => undefined,
      startWaitMs: 200,
    });
    expect(result.handled).toBe(false);
  });

  it('hands back on garbage input and on a missing token', async () => {
    expect((await viaDaemon('not json', env(tmpDir()))).handled).toBe(false);
    expect((await viaDaemon(event, { HARMONY_URL: 'http://x' })).handled).toBe(false);
  });

  it('answers ask when the daemon acked a wait and then vanished', async () => {
    const dir = tmpDir();
    const e = env(dir);
    const { daemonPaths } = await import('../src/agentd-config.js');
    const paths = daemonPaths(e, TOKEN);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('{"ack":true,"waitMs":100}\n');
        setTimeout(() => socket.destroy(), 30);
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    try {
      const result = await viaDaemon(event, e);
      expect(result.handled).toBe(true);
      expect(permissionOf(result.stdout)?.permissionDecision).toBe('ask');
    } finally {
      server.close();
    }
  });

  it('gives up on a daemon that accepts and never answers, without waiting long', async () => {
    const dir = tmpDir();
    const e = env(dir);
    const { daemonPaths } = await import('../src/agentd-config.js');
    const paths = daemonPaths(e, TOKEN);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    try {
      const started = Date.now();
      const result = await callDaemon(
        paths.socket,
        { v: 1, op: 'event', event: {} },
        { ackMs: 200 },
      );
      expect(result.failure).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});

describe('the bot token file', () => {
  const file = (content: string, mode: number) => {
    const dir = tmpDir();
    const p = path.join(dir, 'bot.env');
    writeFileSync(p, content);
    chmodSync(p, mode);
    return p;
  };
  it('reads a bare token or an env file, and refuses a file others can read', () => {
    expect(resolveToken({ HARMONY_BOT_TOKEN_FILE: file(`${TOKEN}\n`, 0o600) })).toBe(TOKEN);
    expect(
      resolveToken({
        HARMONY_BOT_TOKEN_FILE: file(`# bot\nOTHER=1\nHARMONY_BOT_TOKEN="${TOKEN}"\n`, 0o600),
      }),
    ).toBe(TOKEN);
    expect(() => resolveToken({ HARMONY_BOT_TOKEN_FILE: file(TOKEN, 0o644) })).toThrow(/chmod 600/);
    expect(() => resolveToken({ HARMONY_BOT_TOKEN_FILE: file('nothing here', 0o600) })).toThrow(
      /no bot token/,
    );
    expect(() => resolveToken({ HARMONY_BOT_TOKEN_FILE: '/nonexistent/file' })).toThrow(
      /cannot be read/,
    );
  });
  it('prefers the variable and never puts the token in an error', () => {
    expect(resolveToken({ HARMONY_BOT_TOKEN: TOKEN, HARMONY_BOT_TOKEN_FILE: '/nope' })).toBe(TOKEN);
    try {
      resolveToken({ HARMONY_BOT_TOKEN_FILE: file(TOKEN, 0o644) });
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});
