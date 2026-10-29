import type { Panel } from '@harmony/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { mergePanel, usePanels } from './panels.js';

const panel = (id: string, version: number, extra: Partial<Panel> = {}): Panel => ({
  id,
  channelId: '10',
  botId: '2',
  key: `k${id}`,
  view: { blocks: [{ type: 'markdown', text: `v${String(version)}` }] },
  version,
  pinned: false,
  position: Number(id),
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  ...extra,
});

const updated = (p: Panel) => ({
  type: 'panel.updated' as const,
  channelId: p.channelId,
  panel: p,
});

beforeEach(() => usePanels.setState({ byChannel: {}, pending: {} }));

describe('panel versions', () => {
  it('ignores a frame that is not newer', () => {
    const store = usePanels.getState();
    store.receive(updated(panel('1', 3)));
    store.receive(updated(panel('1', 2)));
    store.receive(updated(panel('1', 3, { pinned: true })));
    const [only] = usePanels.getState().byChannel['10'] ?? [];
    expect(only?.version).toBe(3);
    expect(only?.pinned).toBe(false);
  });

  it('applies a newer one and keeps the list ordered by position', () => {
    const store = usePanels.getState();
    store.receive(updated(panel('2', 1)));
    store.receive(updated(panel('1', 1)));
    store.receive(updated(panel('2', 2)));
    const list = usePanels.getState().byChannel['10'] ?? [];
    expect(list.map((p) => `${p.id}:${String(p.version)}`)).toEqual(['1:1', '2:2']);
  });

  it('mergePanel returns the same list when nothing changes', () => {
    const list = [panel('1', 2)];
    expect(mergePanel(list, panel('1', 2))).toBe(list);
  });

  it('removes a deleted panel and ignores deletes for unknown ones', () => {
    const store = usePanels.getState();
    store.receive(updated(panel('1', 1)));
    store.receive({ type: 'panel.deleted', channelId: '10', panelId: '9' });
    expect(usePanels.getState().byChannel['10']).toHaveLength(1);
    store.receive({ type: 'panel.deleted', channelId: '10', panelId: '1' });
    expect(usePanels.getState().byChannel['10']).toEqual([]);
  });
});

describe('a fetch racing live frames', () => {
  it('keeps a live version newer than the fetched one and drops panels the fetch lacks', () => {
    const store = usePanels.getState();
    store.receive(updated(panel('1', 5)));
    store.receive(updated(panel('2', 1)));
    store.setPanels('10', [panel('1', 4), panel('3', 1)]);
    const list = usePanels.getState().byChannel['10'] ?? [];
    expect(list.map((p) => `${p.id}:${String(p.version)}`)).toEqual(['1:5', '3:1']);
  });
});

describe('pending buttons', () => {
  it('tracks a click until its nonce is answered', () => {
    const store = usePanels.getState();
    store.startAction('p1:restart', 'n1');
    store.startAction('p1:refresh', 'n2');
    store.finishAction('n1');
    expect(Object.keys(usePanels.getState().pending)).toEqual(['p1:refresh']);
    store.finishAction('unknown');
    expect(Object.keys(usePanels.getState().pending)).toEqual(['p1:refresh']);
  });
});
