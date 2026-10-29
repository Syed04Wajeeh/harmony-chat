import type { Block, Panel } from '@harmony/shared';
import { useNameOf } from '../../hooks/useNameOf.js';
import { useApp } from '../../store/store.js';
import { Markdown } from '../Markdown.js';
import { ActionRow } from './ActionButton.js';
import { Chart } from './Chart.js';

const STATE_LABEL = {
  ok: 'OK',
  warn: 'Warning',
  bad: 'Down',
  unknown: 'Unknown',
  off: 'Off',
} as const;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function Heading({ children }: { children: string | undefined }) {
  return children ? <h4 className="block-title">{children}</h4> : null;
}

const cell = (value: string | number | null): string =>
  value === null ? '–' : typeof value === 'number' ? value.toLocaleString() : value;

function BlockBody({ block, panel }: { block: Block; panel: Panel }) {
  const nameOf = useNameOf();
  const meId = useApp((state) => state.me?.id ?? '');
  switch (block.type) {
    case 'stat':
      return (
        <div className="stat" data-tone={block.tone ?? 'neutral'}>
          <span className="stat-label">{block.label}</span>
          <span className="stat-value">
            {typeof block.value === 'number' ? block.value.toLocaleString() : block.value}
            {block.unit && <small>{block.unit}</small>}
          </span>
          {block.delta && <span className="stat-delta">{block.delta}</span>}
        </div>
      );
    case 'chart':
      return (
        <>
          <Heading>{block.title}</Heading>
          <Chart block={block} />
        </>
      );
    case 'table':
      return (
        <>
          <Heading>{block.title}</Heading>
          <div className="panel-table-scroll">
            <table className="panel-table">
              <thead>
                <tr>
                  {block.columns.map((column) => (
                    <th key={column.key} scope="col" data-align={column.align}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, index) => (
                  <tr key={index}>
                    {block.columns.map((column) => (
                      <td key={column.key} data-align={column.align}>
                        {cell(row[column.key] ?? null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {block.rows.length === 0 && <p className="panel-empty">No rows</p>}
          </div>
        </>
      );
    case 'status':
      return (
        <>
          <Heading>{block.title}</Heading>
          <ul className="status-list">
            {block.items.map((item, index) => (
              <li key={index} data-state={item.state}>
                <span className="status-dot" aria-hidden="true" />
                <span className="status-label">{item.label}</span>
                {item.detail && <span className="status-detail">{item.detail}</span>}
                <span className="status-pill">{STATE_LABEL[item.state]}</span>
              </li>
            ))}
          </ul>
        </>
      );
    case 'progress': {
      const ratio = clamp(block.value / block.max);
      return (
        <div className="progress" data-tone={block.tone ?? 'neutral'}>
          <div className="progress-head">
            <span>{block.label}</span>
            <span className="progress-figure">
              {block.value.toLocaleString()} / {block.max.toLocaleString()}
            </span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label={block.label}
            aria-valuemin={0}
            aria-valuemax={block.max}
            aria-valuenow={Math.min(block.max, Math.max(0, block.value))}
          >
            <div className="progress-fill" style={{ width: `${String(ratio * 100)}%` }} />
          </div>
        </div>
      );
    }
    case 'kv':
      return (
        <>
          <Heading>{block.title}</Heading>
          <dl className="kv-list">
            {block.pairs.map((pair, index) => (
              <div key={index}>
                <dt>{pair.key}</dt>
                <dd>{pair.value}</dd>
              </div>
            ))}
          </dl>
        </>
      );
    case 'markdown':
      return (
        <div className="panel-markdown">
          <Markdown content={block.text} nameOf={nameOf} meId={meId} />
        </div>
      );
    case 'actions':
      return (
        <ActionRow
          buttons={block.buttons}
          source={{ panelId: panel.id }}
          channelId={panel.channelId}
        />
      );
  }
}

/** One block of a panel view, in a grid cell sized by its `span`. */
export function PanelBlock({ block, panel }: { block: Block; panel: Panel }) {
  // Stat tiles pack two to a row by default; everything else wants the full width.
  const span = block.span ?? (block.type === 'stat' || block.type === 'progress' ? 1 : 'full');
  return (
    <section className="panel-block" data-type={block.type} data-span={String(span)}>
      <BlockBody block={block} panel={panel} />
    </section>
  );
}
