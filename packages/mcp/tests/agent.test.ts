import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PanelView } from '@harmony/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADA, BEN, FakeHarmony, OTHER_BOT } from './fake-harmony.js';
import { call, connect, type ToolOutcome } from './helpers.js';

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

interface Buttons {
  components: {
    buttons: {
      id: string;
      style?: string;
      confirm?: { title: string };
      requiredPermission?: string;
    }[];
  };
}

const buttonsOf = (message: unknown) => (message as Buttons).components.buttons;

describe('agent hub tools', () => {
  let fake: FakeHarmony;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    fake = await FakeHarmony.start();
  });
  afterAll(async () => {
    await fake.stop();
  });
  beforeEach(async () => {
    fake.messages.clear();
    fake.panels.clear();
    fake.panelWrites.length = 0;
    fake.requests.length = 0;
    fake.failures.length = 0;
    fake.panelLimit = 20;
    ({ client, close } = await connect(fake, { agentChannel: '#ops' }));
  });
  afterEach(async () => {
    await close();
  });

  /** The newest message with buttons in channel 12 (#ops). */
  const approvalMessage = () =>
    [...(fake.messages.get('12') ?? [])].reverse().find((m) => 'components' in m);

  describe('request_approval', () => {
    it('posts Approve and Deny buttons, waits, and returns who approved', async () => {
      const pending = call(client, 'request_approval', {
        title: 'Deploy v2',
        details: 'Rolls out **v2** to production.',
        risk: 'medium',
        timeoutSeconds: 30,
      });
      const message = await until(approvalMessage);
      const buttons = buttonsOf(message);
      expect(buttons.map((b) => b.id)).toEqual(['approve', 'deny']);
      expect(buttons[1]?.style).toBe('danger');
      expect(buttons[0]?.confirm).toBeUndefined();
      expect(buttons.every((b) => b.requiredPermission === 'manage_messages')).toBe(true);
      expect(message.content).toContain('Deploy v2');

      const clicked = await fake.click({ messageId: message.id }, 'approve');
      expect(clicked).toMatchObject({ response: { type: 'message', ephemeral: true } });
      const result = await pending;
      expect(result.isError).toBe(false);
      expect(result.data).toMatchObject({
        decision: 'approved',
        by: { id: ADA.id, login: ADA.login, displayName: ADA.displayName },
        messageId: message.id,
      });
      expect(result.text).toContain('Approved by Ada');
      const edited = fake.message(message.id);
      expect(edited?.content).toContain('**Approved** by Ada');
      expect(edited?.content).toContain('Rolls out **v2**');
      expect(edited && 'components' in edited).toBe(false);
    });

    it('returns denied for the Deny button; with nothing pending the socket is closed', async () => {
      const pending = call(client, 'request_approval', {
        title: 'rm -rf build',
        timeoutSeconds: 30,
      });
      const message = await until(approvalMessage);
      await fake.click({ messageId: message.id }, 'deny', BEN);
      const result = await pending;
      expect(result.data).toMatchObject({ decision: 'denied', by: { displayName: 'Ben' } });
      expect(result.text).toContain('Do NOT do this');
      expect(fake.message(message.id)?.content).toContain('**Denied** by Ben');
      await until(() => fake.socketCount === 0);
      expect(await fake.click({ messageId: message.id }, 'approve')).toEqual({ unreachable: true });
    });

    it('asks for a second confirmation on high risk and honours requiredPermission', async () => {
      const pending = call(client, 'request_approval', {
        title: 'Drop the table',
        risk: 'high',
        requiredPermission: 'manage_guild',
        timeoutSeconds: 30,
      });
      const message = await until(approvalMessage);
      const buttons = buttonsOf(message);
      expect(buttons[0]?.confirm?.title).toContain('high-risk');
      expect(buttons[1]?.confirm).toBeUndefined();
      expect(buttons.map((b) => b.requiredPermission)).toEqual(['manage_guild', 'manage_guild']);
      await fake.click({ messageId: message.id }, 'deny');
      await pending;
    });

    it('times out, edits the message and removes the buttons', async () => {
      const result = await call(client, 'request_approval', {
        title: 'Slow one',
        timeoutSeconds: 1,
      });
      expect(result.data).toMatchObject({ decision: 'timeout', by: null });
      expect(result.text).toContain('Treat this as denied');
      const message = [...(fake.messages.get('12') ?? [])].at(-1);
      expect(message?.content).toContain('**Timed out**');
      expect(message && 'components' in message).toBe(false);
    });

    it('keeps waiting across a dropped socket; a click while disconnected is unreachable', async () => {
      const pending = call(client, 'request_approval', {
        title: 'Flaky link',
        timeoutSeconds: 30,
      });
      const message = await until(approvalMessage);
      await until(() => fake.socketCount > 0);
      fake.dropSockets();
      const lost = await fake.click({ messageId: message.id }, 'approve');
      expect(lost).toEqual({ unreachable: true });
      await until(() => fake.socketCount > 0, 8000);
      const clicked = await fake.click({ messageId: message.id }, 'approve');
      expect(clicked).toMatchObject({ response: { ephemeral: true } });
      expect((await pending).data).toMatchObject({ decision: 'approved' });
    });
  });

  describe('runs', () => {
    const latest = () => {
      const row = [...fake.panels.values()].at(-1);
      return row ? PanelView.parse(row.view) : undefined;
    };
    const blockText = (view: PanelView | undefined, id: string) =>
      JSON.stringify(view?.blocks.find((b) => b.id === id) ?? null);

    it('shows a run panel through start, update and finish', async () => {
      const started = await call(client, 'start_run', {
        title: 'Refactor billing',
        step: 'Reading code',
        totalSteps: 4,
      });
      expect(started.isError).toBe(false);
      expect(String(started.data?.panelKey)).toMatch(/^run-[0-9a-f]{8}$/);
      const first = latest();
      expect(first?.title).toBe('Agent run: Refactor billing');
      expect(blockText(first, 'status')).toContain('Running');
      expect(blockText(first, 'steps')).toContain('1 / 4');
      expect(first?.blocks.some((b) => b.type === 'actions')).toBe(true);

      await call(client, 'update_run', { step: 'Editing invoices', note: 'found 3 call sites' });
      await until(() => blockText(latest(), 'info').includes('Editing invoices'));
      expect(blockText(latest(), 'steps')).toContain('2 / 4');
      expect(blockText(latest(), 'notes')).toContain('found 3 call sites');

      const done = await call(client, 'finish_run', { status: 'done', summary: 'Merged' });
      expect(done.isError).toBe(false);
      const final = latest();
      expect(blockText(final, 'status')).toContain('Done');
      expect(blockText(final, 'info')).toContain('Merged');
      expect(final?.blocks.some((b) => b.type === 'actions')).toBe(false);
      const after = await call(client, 'update_run', { step: 'more' });
      expect(after.isError).toBe(true);
      expect(after.text).toContain('already ended');
    });

    it('marks failure', async () => {
      await call(client, 'start_run', { title: 'Flaky' });
      await call(client, 'finish_run', { status: 'failed', summary: 'tests red' });
      expect(blockText(latest(), 'status')).toContain('Failed');
    });

    it('coalesces many updates into few panel writes and the last state wins', async () => {
      await close();
      ({ client, close } = await connect(fake, { agentChannel: '#ops', panelMinIntervalMs: 250 }));
      await call(client, 'start_run', { title: 'Chatty' });
      for (let i = 1; i <= 40; i += 1) await call(client, 'update_run', { step: `step ${i}` });
      await until(() => blockText(latest(), 'info').includes('step 40'));
      // One write for the start and a handful for the burst, far fewer than 41.
      expect(fake.panelWrites.length).toBeLessThanOrEqual(5);
      const gaps = fake.panelWrites.slice(1).map((w, i) => w.at - (fake.panelWrites[i]?.at ?? 0));
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(230);
      await call(client, 'finish_run', { status: 'done' });
    });

    it('flips the run to waiting for approval and back', async () => {
      await call(client, 'start_run', { title: 'Needs a nod' });
      const pending = call(client, 'request_approval', {
        title: 'Push to main',
        timeoutSeconds: 30,
      });
      const message = await until(approvalMessage);
      await until(() => blockText(latest(), 'status').includes('Waiting for approval'));
      await fake.click({ messageId: message.id }, 'approve');
      await pending;
      await until(() => blockText(latest(), 'status').includes('Running'));
      expect(blockText(latest(), 'notes')).toContain('Approved by Ada: Push to main');
    });

    it('flips the run to waiting for reply during ask_human', async () => {
      await call(client, 'start_run', { title: 'Needs an answer' });
      const pending = call(client, 'ask_human', {
        channel: '#ops',
        question: 'Which branch?',
        timeoutSeconds: 30,
      });
      await until(() => blockText(latest(), 'status').includes('Waiting for reply'));
      fake.post('12', ADA, 'main');
      const answer = await pending;
      expect(answer.data).toMatchObject({ status: 'replied' });
      await until(() => blockText(latest(), 'status').includes('Running'));
    });

    it('cancel: marks the run, ends pending approvals, and every later tool says stop', async () => {
      const started = await call(client, 'start_run', { title: 'Doomed' });
      const key = String(started.data?.panelKey);
      const pending = call(client, 'request_approval', {
        title: 'Do a thing',
        timeoutSeconds: 30,
      });
      const message = await until(approvalMessage);
      await until(() => fake.socketCount > 0);

      const clicked = await fake.click({ panelKey: key, channelId: '12' }, 'cancel', BEN);
      expect(clicked).toMatchObject({ response: { type: 'message', ephemeral: true } });

      const result = await pending;
      expect(result.data).toMatchObject({ decision: 'cancelled' });
      expect(result.text).toContain('cancelled by Ben');
      expect(fake.message(message.id)?.content).toContain('**Cancelled**');

      await until(() => blockText(latest(), 'status').includes('Cancelled'));
      expect(latest()?.blocks.some((b) => b.type === 'actions')).toBe(false);
      expect(blockText(latest(), 'notes')).toContain('Cancelled by Ben');

      const sentBefore = fake.requests.length;
      for (const [tool, args] of [
        ['send_message', { channel: '#ops', content: 'hi' }],
        ['read_messages', { channel: '#ops' }],
        ['update_run', { step: 'x' }],
        ['finish_run', { status: 'done' }],
        ['request_approval', { title: 'again' }],
      ] as [string, Record<string, unknown>][]) {
        const out: ToolOutcome = await call(client, tool, args);
        expect(out.isError, tool).toBe(true);
        expect(out.text, tool).toContain('cancelled by Ben');
        expect(out.text, tool).toContain('stop working');
      }
      expect(
        fake.requests
          .slice(sentBefore)
          .some((r) => r.method === 'POST' && r.path.includes('/messages')),
      ).toBe(false);

      // A new run is allowed and clears the stop.
      const again = await call(client, 'start_run', { title: 'Fresh start' });
      expect(again.isError).toBe(false);
      expect((await call(client, 'send_message', { channel: '#ops', content: 'ok' })).isError).toBe(
        false,
      );
    });

    it('makes room by deleting its own finished run panels when the channel is full', async () => {
      await call(client, 'start_run', { title: 'Old' });
      await call(client, 'finish_run', { status: 'done' });
      fake.panelLimit = 1;
      const next = await call(client, 'start_run', { title: 'New' });
      expect(next.isError).toBe(false);
      expect(fake.panels.size).toBe(1);
      expect(PanelView.parse([...fake.panels.values()][0]?.view).title).toContain('New');
    });
  });

  it('wait_for_reply still ignores bots unless includeBots is set', async () => {
    const waiting = call(client, 'wait_for_reply', { channel: '#ops', timeoutSeconds: 1 });
    await sleep(100);
    fake.post('12', OTHER_BOT, 'bot chatter');
    expect((await waiting).data).toMatchObject({ status: 'timeout' });
  });
});
