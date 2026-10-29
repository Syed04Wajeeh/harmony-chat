import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PanelView } from '@harmony/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalDetails,
  loadHookConfig,
  runHook,
  subjectOf,
  type HookInput,
} from '../src/hook.js';
import { ADA, FakeHarmony, TOKEN } from './fake-harmony.js';

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

const event = (extra: Record<string, unknown>) =>
  JSON.stringify({ session_id: 'sess-1234567890', cwd: '/work/shop', ...extra });

const bash = (command: string) =>
  event({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

const decisionOf = (stdout: string | undefined) =>
  (
    JSON.parse(stdout ?? '{}') as {
      hookSpecificOutput?: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    }
  ).hookSpecificOutput;

describe('harmony-hook', () => {
  let fake: FakeHarmony;
  let env: Record<string, string>;

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
    env = {
      HARMONY_URL: fake.url,
      HARMONY_BOT_TOKEN: TOKEN,
      HARMONY_AGENT_CHANNEL: '#ops',
      HARMONY_APPROVAL_PATTERN: 'git push|rm -rf|docker',
      HARMONY_APPROVAL_TIMEOUT_SECONDS: '30',
      HARMONY_HOOK_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), 'harmony-hook-test-')),
    };
  });

  const pendingMessage = () =>
    [...(fake.messages.get('12') ?? [])].reverse().find((m) => 'components' in m);

  describe('PreToolUse', () => {
    it('says nothing for a tool call the pattern does not select, without touching Harmony', async () => {
      const result = await runHook(bash('ls -la'), { ...env, HARMONY_URL: 'http://127.0.0.1:1' });
      expect(result).toEqual({});
      expect(fake.messages.get('12') ?? []).toHaveLength(0);
    });

    it('says nothing when no pattern is configured', async () => {
      const without = { ...env, HARMONY_APPROVAL_PATTERN: '' };
      expect(await runHook(bash('git push --force'), without)).toEqual({});
    });

    it('asks in Harmony and answers allow after Approve', async () => {
      const running = runHook(bash('git push origin main'), env);
      const message = await until(pendingMessage);
      expect(message.content).toContain('Claude Code wants to run Bash');
      expect(message.content).toContain('git push origin main');
      await fake.click({ messageId: message.id }, 'approve');
      const result = await running;
      expect(decisionOf(result.stdout)).toEqual({
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Approved in Harmony by Ada (@ada@example.com).',
      });
    });

    it('answers deny after Deny', async () => {
      const running = runHook(bash('rm -rf node_modules'), env);
      const message = await until(pendingMessage);
      await fake.click({ messageId: message.id }, 'deny');
      const decision = decisionOf((await running).stdout);
      expect(decision?.permissionDecision).toBe('deny');
      expect(decision?.permissionDecisionReason).toContain('Denied in Harmony by Ada');
    });

    it('treats a timeout as deny by default, or ask when configured', async () => {
      const short = { ...env, HARMONY_APPROVAL_TIMEOUT_SECONDS: '1' };
      const denied = decisionOf((await runHook(bash('docker rm x'), short)).stdout);
      expect(denied?.permissionDecision).toBe('deny');
      expect(denied?.permissionDecisionReason).toContain('No decision');
      const asked = decisionOf(
        (await runHook(bash('docker rm x'), { ...short, HARMONY_APPROVAL_ON_TIMEOUT: 'ask' }))
          .stdout,
      );
      expect(asked?.permissionDecision).toBe('ask');
      const edited = [...(fake.messages.get('12') ?? [])].at(-1);
      expect(edited?.content).toContain('**Timed out**');
    });

    it('fails safe to ask when Harmony cannot be reached', async () => {
      const result = await runHook(bash('git push'), { ...env, HARMONY_URL: 'http://127.0.0.1:1' });
      const decision = decisionOf(result.stdout);
      expect(decision?.permissionDecision).toBe('ask');
      expect(decision?.permissionDecisionReason).toContain('asking in the terminal');
      expect(result.log).not.toContain(TOKEN);
    });

    it('fails safe to ask when it is misconfigured, and never prints the token', async () => {
      for (const broken of [
        { HARMONY_BOT_TOKEN: '' },
        { HARMONY_AGENT_CHANNEL: '' },
        { HARMONY_APPROVAL_TIMEOUT_SECONDS: '0' },
        { HARMONY_APPROVAL_ON_TIMEOUT: 'maybe' },
        { HARMONY_APPROVAL_PATTERN: '(' },
      ]) {
        const result = await runHook(bash('git push'), { ...env, ...broken });
        expect(decisionOf(result.stdout)?.permissionDecision, JSON.stringify(broken)).toBe('ask');
        expect(JSON.stringify(result)).not.toContain(TOKEN);
      }
    });

    it('never outlives its hard timeout: answers ask', async () => {
      const started = Date.now();
      const running = runHook(bash('git push'), { ...env, HARMONY_HOOK_MAX_SECONDS: '1' });
      const message = await until(pendingMessage);
      const result = await running;
      expect(Date.now() - started).toBeLessThan(3000);
      expect(decisionOf(result.stdout)?.permissionDecision).toBe('ask');
      expect(result.log).toContain('took longer than 1s');
      // Let the abandoned approval finish so it leaves nothing running.
      await fake.click({ messageId: message.id }, 'deny');
    });

    it('matches non-Bash tools on the tool name and input, and ignores a malformed event', async () => {
      const input: HookInput = {
        session_id: 's',
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__db__query',
        tool_input: { sql: 'drop table users' },
      };
      expect(subjectOf(input)).toContain('drop table users');
      const ignored = await runHook('not json', env);
      expect(ignored.stdout).toBeUndefined();
      expect(ignored.log).toContain('ignoring');
    });

    it('keeps a command from closing its code fence or pinging people', () => {
      const details = approvalDetails({
        session_id: 'abcdef123456',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo ```\n**done** <@7> @everyone' },
      });
      expect(details).toContain('````\necho ```');
      expect(details).not.toContain('<@7>');
      expect(details).not.toContain('@everyone');
    });
  });

  describe('other events', () => {
    it('posts a Notification message to the channel', async () => {
      const result = await runHook(
        event({
          hook_event_name: 'Notification',
          message: 'Claude needs your permission to use Bash',
          notification_type: 'permission_prompt',
        }),
        env,
      );
      expect(result).toEqual({});
      const posted = (fake.messages.get('12') ?? []).at(-1);
      expect(posted?.content).toContain('Claude Code needs your input');
      expect(posted?.content).toContain('permission to use Bash');
    });

    it('posts a short finished note on Stop and keeps the reply text out by default', async () => {
      const stop = event({ hook_event_name: 'Stop', last_assistant_message: 'secret plan: x' });
      await runHook(stop, env);
      const plain = (fake.messages.get('12') ?? []).at(-1);
      expect(plain?.content).toContain('Claude Code finished');
      expect(plain?.content).toContain('`shop`');
      expect(plain?.content).not.toContain('secret plan');
      await runHook(stop, { ...env, HARMONY_HOOK_INCLUDE_TEXT: '1' });
      expect((fake.messages.get('12') ?? []).at(-1)?.content).toContain('secret plan');
    });

    it('does nothing for events it does not handle', async () => {
      expect(await runHook(event({ hook_event_name: 'PostToolUse' }), env)).toEqual({});
      expect(fake.messages.get('12') ?? []).toHaveLength(0);
    });

    it('never fails a Notification when Harmony is down', async () => {
      const result = await runHook(event({ hook_event_name: 'Notification', message: 'hi' }), {
        ...env,
        HARMONY_URL: 'http://127.0.0.1:1',
      });
      expect(result.stdout).toBeUndefined();
      expect(result.log).toContain('harmony-hook');
    });
  });

  describe('optional run panel', () => {
    it('follows a session from start to Stop on one panel', async () => {
      const on = { ...env, HARMONY_HOOK_RUN: '1' };
      await runHook(event({ hook_event_name: 'SessionStart', source: 'startup' }), on);
      expect(fake.panels.size).toBe(1);
      await runHook(event({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' }), on);
      const running = runHook(bash('git push'), on);
      const message = await until(pendingMessage);
      const view = () => PanelView.parse([...fake.panels.values()][0]?.view);
      await until(() => JSON.stringify(view()).includes('Waiting for approval'));
      await fake.click({ messageId: message.id }, 'approve', ADA);
      await running;
      await runHook(event({ hook_event_name: 'Stop' }), on);
      expect(fake.panels.size).toBe(1);
      const final = JSON.stringify(view());
      expect(final).toContain('Done');
      expect(final).not.toContain('fix the bug');
      expect(final).not.toContain('"actions"');
      expect(existsSync(path.join(env.HARMONY_HOOK_STATE_DIR ?? '', 'sess-1234567890.json'))).toBe(
        false,
      );
    });
  });

  it('reads the documented environment', () => {
    const config = loadHookConfig({
      ...env,
      HARMONY_APPROVAL_ON_TIMEOUT: 'ask',
      HARMONY_APPROVAL_RISK: 'high',
    });
    expect(config).toMatchObject({
      channel: '#ops',
      approvalSeconds: 30,
      maxSeconds: 50,
      onTimeout: 'ask',
      risk: 'high',
      permission: 'manage_messages',
      runPanel: false,
    });
  });
});
