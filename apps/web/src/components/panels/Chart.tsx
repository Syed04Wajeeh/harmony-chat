import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ChartBlock } from '@harmony/shared';
import {
  formatFullTime,
  formatNumber,
  formatTime,
  isTimeAxis,
  nearestIndex,
  niceTicks,
  prepare,
  scale,
  sharedXs,
  timeTicks,
  valueAt,
  xDomain,
  yDomain,
} from '../../lib/chart.js';

const HEIGHT = 200;
const MARGIN = { top: 10, right: 14, bottom: 26, left: 44 };
const DEFAULT_WIDTH = 560;
const X_TICKS = 5;

/** Width of an element, following resizes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || DEFAULT_WIDTH);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(160, Math.round(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

const withUnit = (value: number, unit: string | undefined) =>
  unit ? `${formatNumber(value)}${unit.length <= 2 ? '' : ' '}${unit}` : formatNumber(value);

/**
 * A small dependency-free SVG chart: line, area or bar over a numeric or time x axis. Colors come
 * from the `--color-chart-*` tokens through CSS classes, so themes restyle it. Hovering (or
 * arrowing through it with the keyboard) shows the values at the nearest x.
 */
export function Chart({ block }: { block: ChartBlock }) {
  const { ref, width } = useWidth();
  const lines = useMemo(() => prepare(block.series), [block.series]);
  const time = useMemo(() => isTimeAxis(block.series), [block.series]);
  const xs = useMemo(() => sharedXs(lines), [lines]);
  const [hover, setHover] = useState<number | null>(null);

  const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const y = yDomain(lines, { kind: block.kind, yMin: block.yMin, yMax: block.yMax });
  const yTicks = niceTicks(y.min, y.max, 4).filter((v) => v >= y.min && v <= y.max);
  const sy = scale(y, MARGIN.top + innerH, MARGIN.top);
  const bars = block.kind === 'bar';
  const xd = xDomain(lines);
  const band = bars ? innerW / Math.max(1, xs.length) : 0;
  const sx = bars
    ? (v: number) => MARGIN.left + (nearestIndex(xs, v) + 0.5) * band
    : scale(xd, MARGIN.left, MARGIN.left + innerW);
  const span = xd.max - xd.min;

  const xLabels = useMemo(() => {
    if (xs.length === 0) return [];
    if (bars) {
      const every = Math.ceil(xs.length / Math.max(2, Math.floor(innerW / 70)));
      return xs.filter((_, i) => i % every === 0);
    }
    return timeTicks(xd, Math.max(2, Math.min(X_TICKS, Math.floor(innerW / 90))));
  }, [xs, bars, xd, innerW]);
  const formatX = (v: number) => (time ? formatTime(v, span) : formatNumber(v));

  const hoverX = hover === null ? undefined : xs[hover];
  const baseline = sy(Math.max(y.min, Math.min(0, y.max)));

  function moveTo(clientX: number, rect: DOMRect) {
    if (xs.length === 0) return;
    const px = clientX - rect.left;
    if (bars) {
      setHover(Math.max(0, Math.min(xs.length - 1, Math.floor((px - MARGIN.left) / band))));
      return;
    }
    const target = xd.min + ((px - MARGIN.left) / innerW) * (xd.max - xd.min);
    setHover(nearestIndex(xs, target));
  }
  const onPointer = (event: PointerEvent<SVGSVGElement>) =>
    moveTo(event.clientX, event.currentTarget.getBoundingClientRect());
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (xs.length === 0) return;
    if (event.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? xs.length) - 1));
    else if (event.key === 'ArrowRight') setHover((h) => Math.min(xs.length - 1, (h ?? -1) + 1));
    else if (event.key === 'Escape') setHover(null);
    else return;
    event.preventDefault();
  };

  const latest = lines
    .map((line) => {
      const last = line.points.at(-1);
      return last ? `${line.name} ${withUnit(last.y, block.yUnit)}` : null;
    })
    .filter(Boolean)
    .join(', ');
  const empty = xs.length === 0;

  const tooltipLeft =
    hoverX === undefined ? 0 : Math.min(Math.max(sx(hoverX), 70), Math.max(70, width - 70));

  return (
    <div className="chart" ref={ref}>
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`}
        role="img"
        aria-label={
          empty
            ? `${block.title ?? 'Chart'}: no data yet`
            : `${block.title ?? 'Chart'}. Latest: ${latest}. Use the arrow keys to read values.`
        }
        tabIndex={empty ? -1 : 0}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={(event) => event.pointerType === 'mouse' && setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <g className="chart-grid">
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={MARGIN.left} x2={MARGIN.left + innerW} y1={sy(tick)} y2={sy(tick)} />
              <text x={MARGIN.left - 8} y={sy(tick)} dy="0.32em" textAnchor="end">
                {formatNumber(tick)}
              </text>
            </g>
          ))}
        </g>
        <g className="chart-axis">
          {xLabels.map((tick, i) => (
            <text
              key={tick}
              x={sx(tick)}
              y={HEIGHT - 8}
              textAnchor={i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'}
            >
              {formatX(tick)}
            </text>
          ))}
        </g>

        {lines.map((line, index) => {
          const cls = `chart-s${String(index % 8)}`;
          if (bars) {
            const barW = Math.max(2, (band * 0.72) / lines.length);
            return (
              <g key={line.name} className={`chart-series ${cls}`}>
                {line.points.map((p) => {
                  const x0 = sx(p.x) - (band * 0.72) / 2 + index * barW;
                  const top = Math.min(sy(p.y), baseline);
                  return (
                    <rect
                      key={p.x}
                      x={x0}
                      y={top}
                      width={Math.max(1, barW - 1)}
                      height={Math.max(1, Math.abs(sy(p.y) - baseline))}
                      rx={2}
                    />
                  );
                })}
              </g>
            );
          }
          if (line.points.length === 0) return null;
          const path = line.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`)
            .join(' ');
          const first = line.points[0];
          const last = line.points.at(-1);
          return (
            <g key={line.name} className={`chart-series ${cls}`}>
              {block.kind === 'area' && first && last && (
                <path
                  className="chart-fill"
                  d={`${path} L${sx(last.x).toFixed(1)} ${baseline.toFixed(1)} L${sx(first.x).toFixed(1)} ${baseline.toFixed(1)} Z`}
                />
              )}
              <path className="chart-line" d={path} />
              {line.points.length === 1 && first && (
                <circle cx={sx(first.x)} cy={sy(first.y)} r={3.5} />
              )}
            </g>
          );
        })}

        {hoverX !== undefined && (
          <g className="chart-hover">
            <line x1={sx(hoverX)} x2={sx(hoverX)} y1={MARGIN.top} y2={MARGIN.top + innerH} />
            {!bars &&
              lines.map((line, index) => {
                const v = valueAt(line, hoverX);
                return v === undefined ? null : (
                  <circle
                    key={line.name}
                    className={`chart-s${String(index % 8)}`}
                    cx={sx(hoverX)}
                    cy={sy(v)}
                    r={4}
                  />
                );
              })}
          </g>
        )}
      </svg>

      {hoverX !== undefined && (
        <div className="chart-tooltip" style={{ left: tooltipLeft }} role="status">
          <time>{time ? formatFullTime(hoverX) : formatNumber(hoverX)}</time>
          {lines.map((line, index) => {
            const v = valueAt(line, hoverX);
            return v === undefined ? null : (
              <div key={line.name} className="chart-tooltip-row">
                <i className={`chart-swatch chart-s${String(index % 8)}`} aria-hidden="true" />
                <span>{line.name}</span>
                <strong>{withUnit(v, block.yUnit)}</strong>
              </div>
            );
          })}
        </div>
      )}

      {lines.length > 1 && (
        <ul className="chart-legend" aria-label="Series">
          {lines.map((line, index) => (
            <li key={line.name}>
              <i className={`chart-swatch chart-s${String(index % 8)}`} aria-hidden="true" />
              {line.name}
            </li>
          ))}
        </ul>
      )}
      {empty && <p className="chart-empty">No data yet</p>}
    </div>
  );
}
