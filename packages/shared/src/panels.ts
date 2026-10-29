import { z } from 'zod';
import { Id } from './chat.js';
import { Button, MAX_BUTTONS, PanelSlug } from './components.js';

export * from './components.js';

/**
 * Panels are declarative views a bot publishes into a channel. Harmony renders them with its own
 * components and theme tokens; a view never carries HTML, styles, scripts or URLs for styling.
 */

export const PANEL_LIMITS = {
  title: 100,
  blocks: 24,
  seriesPerChart: 8,
  pointsPerSeries: 500,
  tableColumns: 8,
  tableRows: 100,
  statusItems: 50,
  kvPairs: 30,
  markdown: 4000,
  buttons: MAX_BUTTONS,
  /** The whole view, serialized as JSON. */
  viewBytes: 64 * 1024,
  panelsPerChannel: 20,
  pointsPerAppend: 100,
} as const;

const Label = z.string().min(1).max(100);
const Detail = z.string().max(200);
export const Tone = z.enum(['neutral', 'good', 'warn', 'bad']);
export type Tone = z.infer<typeof Tone>;

const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;

const base = {
  id: PanelSlug.optional(),
  span: z.union([z.literal(1), z.literal(2), z.literal('full')]).optional(),
};

const CellValue = z.union([z.string().max(500), z.number(), z.null()]);
export const PointX = z.union([z.number(), z.iso.datetime({ offset: true })]);
export const ChartPoint = z.object({ x: PointX, y: z.number() });
export type ChartPoint = z.infer<typeof ChartPoint>;

export const ChartSeries = z.object({
  name: z.string().min(1).max(60),
  points: z.array(ChartPoint).max(PANEL_LIMITS.pointsPerSeries),
});

export const StatBlock = z.object({
  ...base,
  type: z.literal('stat'),
  label: Label,
  value: z.union([z.string().max(60), z.number()]),
  unit: z.string().max(20).optional(),
  delta: z.string().max(30).optional(),
  tone: Tone.optional(),
});
export const ChartBlock = z.object({
  ...base,
  type: z.literal('chart'),
  title: Label.optional(),
  kind: z.enum(['line', 'bar', 'area']),
  series: z.array(ChartSeries).max(PANEL_LIMITS.seriesPerChart),
  yUnit: z.string().max(20).optional(),
  yMin: z.number().optional(),
  yMax: z.number().optional(),
});
export const TableBlock = z
  .object({
    ...base,
    type: z.literal('table'),
    title: Label.optional(),
    columns: z
      .array(
        z.object({
          key: PanelSlug,
          label: z.string().max(60),
          align: z.enum(['left', 'right']).optional(),
        }),
      )
      .min(1)
      .max(PANEL_LIMITS.tableColumns),
    rows: z.array(z.record(z.string(), CellValue)).max(PANEL_LIMITS.tableRows),
  })
  .refine((t) => unique(t.columns.map((c) => c.key)), { message: 'Duplicate column key' });
export const StatusBlock = z.object({
  ...base,
  type: z.literal('status'),
  title: Label.optional(),
  items: z
    .array(
      z.object({
        label: Label,
        state: z.enum(['ok', 'warn', 'bad', 'unknown', 'off']),
        detail: Detail.optional(),
      }),
    )
    .max(PANEL_LIMITS.statusItems),
});
export const ProgressBlock = z.object({
  ...base,
  type: z.literal('progress'),
  label: Label,
  value: z.number(),
  max: z.number().positive(),
  tone: Tone.optional(),
});
export const KvBlock = z.object({
  ...base,
  type: z.literal('kv'),
  title: Label.optional(),
  pairs: z
    .array(z.object({ key: z.string().min(1).max(60), value: z.string().max(300) }))
    .max(PANEL_LIMITS.kvPairs),
});
export const MarkdownBlock = z.object({
  ...base,
  type: z.literal('markdown'),
  text: z.string().max(PANEL_LIMITS.markdown),
});
export const ActionsBlock = z
  .object({
    ...base,
    type: z.literal('actions'),
    buttons: z.array(Button).min(1).max(PANEL_LIMITS.buttons),
  })
  .refine((a) => unique(a.buttons.map((b) => b.id)), { message: 'Duplicate button id' });

export const Block = z.discriminatedUnion('type', [
  StatBlock,
  ChartBlock,
  TableBlock,
  StatusBlock,
  ProgressBlock,
  KvBlock,
  MarkdownBlock,
  ActionsBlock,
]);
export type Block = z.infer<typeof Block>;
export type ChartBlock = z.infer<typeof ChartBlock>;

export const viewBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

export const PanelView = z
  .object({
    title: z.string().min(1).max(PANEL_LIMITS.title).optional(),
    blocks: z.array(Block).min(1).max(PANEL_LIMITS.blocks),
  })
  .superRefine((view, ctx) => {
    const ids = view.blocks.flatMap((b) => (b.id ? [b.id] : []));
    if (!unique(ids)) ctx.addIssue({ code: 'custom', message: 'Duplicate block id' });
    const buttons = view.blocks.flatMap((b) =>
      b.type === 'actions' ? b.buttons.map((x) => x.id) : [],
    );
    if (!unique(buttons)) ctx.addIssue({ code: 'custom', message: 'Duplicate button id' });
    if (viewBytes(view) > PANEL_LIMITS.viewBytes) {
      ctx.addIssue({ code: 'custom', message: 'View is larger than 64 KiB' });
    }
  });
export type PanelView = z.infer<typeof PanelView>;

/** Every button in a view, in order. */
export function viewButtons(view: PanelView): Button[] {
  return view.blocks.flatMap((block) => (block.type === 'actions' ? block.buttons : []));
}

export const Panel = z.object({
  id: Id,
  channelId: Id,
  botId: Id,
  key: PanelSlug,
  view: PanelView,
  /** Starts at 1 and grows with every change; clients ignore a frame that is not newer. */
  version: z.number().int().min(1),
  pinned: z.boolean(),
  position: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Panel = z.infer<typeof Panel>;

export const PanelKeyParams = z.object({ id: Id, key: PanelSlug });
export const PanelIdParams = z.object({ panelId: Id });
export const PutPanelBody = z.object({ view: PanelView, pinned: z.boolean().optional() });
export type PutPanelBody = z.infer<typeof PutPanelBody>;
export const AppendPointsBody = z.object({
  blockId: PanelSlug,
  series: z.string().min(1).max(60),
  points: z.array(ChartPoint).min(1).max(PANEL_LIMITS.pointsPerAppend),
});
export type AppendPointsBody = z.infer<typeof AppendPointsBody>;
export const UpdatePanelBody = z.object({ pinned: z.boolean() });
export const ListPanelsResponse = z.object({ panels: z.array(Panel) });

/**
 * Appends points to a chart's series (creating the series if the chart has room), keeps the
 * newest points, and if the view is still over the size limit drops the oldest points of the
 * longest series until it fits. Returns null when the block is missing, not a chart, or full.
 */
export function appendPoints(view: PanelView, body: AppendPointsBody): PanelView | null {
  const blocks = view.blocks.map((block) => ({ ...block })) as Block[];
  const target = blocks.find((b): b is ChartBlock => b.type === 'chart' && b.id === body.blockId);
  if (!target) return null;
  const series = target.series.map((s) => ({ ...s, points: [...s.points] }));
  let line = series.find((s) => s.name === body.series);
  if (!line) {
    if (series.length >= PANEL_LIMITS.seriesPerChart) return null;
    line = { name: body.series, points: [] };
    series.push(line);
  }
  line.points.push(...body.points);
  if (line.points.length > PANEL_LIMITS.pointsPerSeries) {
    line.points.splice(0, line.points.length - PANEL_LIMITS.pointsPerSeries);
  }
  target.series = series;
  const next: PanelView = { ...view, blocks };
  while (viewBytes(next) > PANEL_LIMITS.viewBytes) {
    const longest = series.reduce((a, b) => (b.points.length > a.points.length ? b : a));
    if (longest.points.length <= 1) break;
    longest.points.shift();
  }
  return next;
}
