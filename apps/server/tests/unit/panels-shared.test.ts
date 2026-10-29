import { describe, expect, it } from 'vitest';
import {
  AppendPointsBody,
  BotMessage,
  InteractionPayload,
  InteractionResponse,
  PANEL_LIMITS,
  PanelView,
  appendPoints,
  viewBytes,
  viewButtons,
} from '@harmony/shared';

const stat = { type: 'stat', label: 'CPU', value: 41, unit: '%' } as const;
const chart = {
  type: 'chart',
  id: 'cpu',
  kind: 'line',
  series: [{ name: 'host', points: [{ x: 1, y: 2 }] }],
} as const;

describe('PanelView', () => {
  it('accepts every block type', () => {
    const view = {
      title: 'Host',
      blocks: [
        stat,
        chart,
        { type: 'table', columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'a' }] },
        { type: 'status', items: [{ label: 'db', state: 'ok', detail: 'up' }] },
        { type: 'progress', label: 'Disk', value: 40, max: 100, tone: 'warn' },
        { type: 'kv', pairs: [{ key: 'os', value: 'linux' }] },
        { type: 'markdown', text: '**hi**' },
        { type: 'actions', buttons: [{ id: 'restart', label: 'Restart', style: 'danger' }] },
      ],
    };
    expect(PanelView.safeParse(view).success).toBe(true);
  });

  it('needs 1 to 24 blocks', () => {
    expect(PanelView.safeParse({ blocks: [] }).success).toBe(false);
    const many = Array.from({ length: 25 }, () => stat);
    expect(PanelView.safeParse({ blocks: many }).success).toBe(false);
    expect(PanelView.safeParse({ blocks: many.slice(0, 24) }).success).toBe(true);
  });

  it('rejects unknown block types and tones', () => {
    expect(PanelView.safeParse({ blocks: [{ type: 'html', html: '<b>x</b>' }] }).success).toBe(
      false,
    );
    expect(PanelView.safeParse({ blocks: [{ ...stat, tone: 'purple' }] }).success).toBe(false);
  });

  it('rejects duplicate block ids and duplicate button ids', () => {
    expect(PanelView.safeParse({ blocks: [chart, { ...stat, id: 'cpu' }] }).success).toBe(false);
    const button = { id: 'go', label: 'Go' };
    const actions = { type: 'actions', buttons: [button] };
    expect(PanelView.safeParse({ blocks: [actions, actions] }).success).toBe(false);
    expect(
      PanelView.safeParse({ blocks: [{ type: 'actions', buttons: [button, button] }] }).success,
    ).toBe(false);
  });

  it('limits series, points, columns, rows, items, pairs and buttons', () => {
    const series = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `s${String(i)}`, points: [] }));
    expect(PanelView.safeParse({ blocks: [{ ...chart, series: series(8) }] }).success).toBe(true);
    expect(PanelView.safeParse({ blocks: [{ ...chart, series: series(9) }] }).success).toBe(false);
    const points = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: i }));
    const withPoints = (n: number) => ({ ...chart, series: [{ name: 'a', points: points(n) }] });
    expect(PanelView.safeParse({ blocks: [withPoints(500)] }).success).toBe(true);
    expect(PanelView.safeParse({ blocks: [withPoints(501)] }).success).toBe(false);

    const columns = Array.from({ length: 9 }, (_, i) => ({ key: `c${String(i)}`, label: 'c' }));
    expect(PanelView.safeParse({ blocks: [{ type: 'table', columns, rows: [] }] }).success).toBe(
      false,
    );
    const rows = Array.from({ length: 101 }, () => ({ a: 1 }));
    const table = { type: 'table', columns: [{ key: 'a', label: 'A' }] };
    expect(PanelView.safeParse({ blocks: [{ ...table, rows }] }).success).toBe(false);
    expect(PanelView.safeParse({ blocks: [{ ...table, rows: rows.slice(1) }] }).success).toBe(true);

    const items = Array.from({ length: 51 }, () => ({ label: 'x', state: 'ok' }));
    expect(PanelView.safeParse({ blocks: [{ type: 'status', items }] }).success).toBe(false);
    const pairs = Array.from({ length: 31 }, () => ({ key: 'k', value: 'v' }));
    expect(PanelView.safeParse({ blocks: [{ type: 'kv', pairs }] }).success).toBe(false);
    const buttons = Array.from({ length: 6 }, (_, i) => ({ id: `b${String(i)}`, label: 'B' }));
    expect(PanelView.safeParse({ blocks: [{ type: 'actions', buttons }] }).success).toBe(false);
  });

  it('accepts ISO times and numbers on the x axis, but not other strings', () => {
    const point = (x: unknown) => ({
      blocks: [{ ...chart, series: [{ name: 'a', points: [{ x, y: 1 }] }] }],
    });
    expect(PanelView.safeParse(point('2026-10-29T10:00:00Z')).success).toBe(true);
    expect(PanelView.safeParse(point('2026-10-29T10:00:00+02:00')).success).toBe(true);
    expect(PanelView.safeParse(point('yesterday')).success).toBe(false);
  });

  it('checks button ids, labels and the permission key shape', () => {
    const view = (button: object) => ({ blocks: [{ type: 'actions', buttons: [button] }] });
    expect(PanelView.safeParse(view({ id: 'Go!', label: 'Go' })).success).toBe(false);
    expect(PanelView.safeParse(view({ id: 'go', label: 'x'.repeat(41) })).success).toBe(false);
    expect(
      PanelView.safeParse(view({ id: 'go', label: 'Go', requiredPermission: 'manage_messages' }))
        .success,
    ).toBe(true);
    expect(
      PanelView.safeParse(view({ id: 'go', label: 'Go', requiredPermission: 'DROP TABLE' }))
        .success,
    ).toBe(false);
    expect(
      PanelView.safeParse(view({ id: 'go', label: 'Go', confirm: { title: 'Sure?' } })).success,
    ).toBe(true);
  });

  it('caps the serialized view at 64 KiB', () => {
    const big = {
      blocks: [{ type: 'markdown', text: 'x'.repeat(PANEL_LIMITS.markdown) }].concat(
        Array.from({ length: 23 }, () => ({ type: 'markdown', text: 'y'.repeat(2900) })),
      ),
    };
    expect(viewBytes(big)).toBeGreaterThan(PANEL_LIMITS.viewBytes);
    expect(PanelView.safeParse(big).success).toBe(false);
  });

  it('lists the buttons of a view in order', () => {
    const view = PanelView.parse({
      blocks: [
        { type: 'actions', buttons: [{ id: 'a', label: 'A' }] },
        stat,
        { type: 'actions', buttons: [{ id: 'b', label: 'B' }] },
      ],
    });
    expect(viewButtons(view).map((b) => b.id)).toEqual(['a', 'b']);
  });
});

describe('appendPoints', () => {
  const view = PanelView.parse({ blocks: [chart] });
  const body = (points: number, series = 'host') =>
    AppendPointsBody.parse({
      blockId: 'cpu',
      series,
      points: Array.from({ length: points }, (_, i) => ({ x: 100 + i, y: i })),
    });

  it('adds to an existing series without touching the original', () => {
    const next = appendPoints(view, body(2));
    const block = next?.blocks[0];
    expect(block?.type === 'chart' && block.series[0]?.points).toHaveLength(3);
    expect(chart.series[0].points).toHaveLength(1);
  });

  it('creates a missing series', () => {
    const next = appendPoints(view, body(1, 'other'));
    const block = next?.blocks[0];
    expect(block?.type === 'chart' && block.series.map((s) => s.name)).toEqual(['host', 'other']);
  });

  it('keeps the newest 500 points', () => {
    let current: PanelView | null = view;
    for (let i = 0; i < 6; i++) current = current && appendPoints(current, body(100));
    const block = current?.blocks[0];
    const points = block?.type === 'chart' ? (block.series[0]?.points ?? []) : [];
    expect(points).toHaveLength(500);
    expect(points[499]).toEqual({ x: 199, y: 99 });
  });

  it('returns null for an unknown or non-chart block', () => {
    expect(appendPoints(view, { ...body(1), blockId: 'nope' })).toBeNull();
    const withStat = PanelView.parse({ blocks: [{ ...stat, id: 'cpu' }] });
    expect(appendPoints(withStat, body(1))).toBeNull();
  });
});

describe('bot messages and interactions', () => {
  it('BotMessage takes buttons', () => {
    const parsed = BotMessage.parse({
      content: 'Deploy?',
      components: { buttons: [{ id: 'yes', label: 'Yes', style: 'primary' }] },
    });
    expect(parsed.components?.buttons).toHaveLength(1);
    expect(BotMessage.safeParse({ content: 'x', components: { buttons: [] } }).success).toBe(false);
  });

  it('InteractionResponse knows update_panel', () => {
    const response = InteractionResponse.safeParse({
      type: 'update_panel',
      view: { blocks: [stat] },
    });
    expect(response.success).toBe(true);
    expect(
      InteractionResponse.safeParse({ type: 'update_panel', view: { blocks: [] } }).success,
    ).toBe(false);
  });

  it('InteractionPayload is a union on type', () => {
    const common = {
      id: '1',
      token: 't',
      guildId: '2',
      channelId: '3',
      user: { id: '4', login: 'a', displayName: 'A' },
      createdAt: '2026-10-29T10:00:00.000Z',
      expiresAt: '2026-10-29T10:15:00.000Z',
    };
    const command = { ...common, type: 'command', command: { name: 'echo', options: {} } };
    const action = {
      ...common,
      type: 'action',
      action: { id: 'restart', source: { kind: 'panel', panelId: '9', key: 'host' } },
    };
    expect(InteractionPayload.safeParse(command).success).toBe(true);
    expect(InteractionPayload.safeParse(action).success).toBe(true);
    expect(InteractionPayload.safeParse({ ...action, action: undefined }).success).toBe(false);
  });
});
