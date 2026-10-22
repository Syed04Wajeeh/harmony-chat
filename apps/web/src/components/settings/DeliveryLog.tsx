import { DELIVERY_STATUSES, type Delivery } from '@harmony/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { formatAbsolute, formatTimestamp } from '../../lib/time.js';
import { attempt, reportError } from '../../store/actions.js';
import { useUi } from '../../store/ui.js';

const PAGE_SIZE = 10;
type StatusFilter = (typeof DELIVERY_STATUSES)[number] | '';

/** Outgoing event deliveries, newest first. A table on desktop, stacked cards on phones. */
export function DeliveryLog({ botId }: { botId: string }) {
  const [status, setStatus] = useState<StatusFilter>('');
  /** `before` cursors of the pages visited so far; the last one is the page on screen. */
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reload, setReload] = useState(0);
  const before = cursors.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    api
      .deliveries(botId, {
        status: status || undefined,
        before,
        limit: PAGE_SIZE + 1,
        signal: controller.signal,
      })
      .then((list) => {
        setRows(list.slice(0, PAGE_SIZE));
        setHasMore(list.length > PAGE_SIZE);
      })
      .catch((error: unknown) => reportError(error, 'Could not load deliveries'));
    return () => controller.abort();
  }, [botId, status, before, reload]);

  const redeliver = useCallback(
    async (delivery: Delivery) => {
      const queued = await attempt(
        api.redeliver(botId, delivery.id).then(() => true),
        'Could not queue the delivery',
      );
      if (queued) {
        useUi.getState().pushToast('Delivery queued again', 'info');
        setReload((n) => n + 1);
      }
    },
    [botId],
  );

  const last = rows?.at(-1);
  return (
    <div className="deliveries">
      <div className="deliveries-toolbar">
        <label className="inline-field">
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => {
              setRows(null);
              setCursors([undefined]);
              setStatus(event.target.value as StatusFilter);
            }}
          >
            <option value="">All</option>
            {DELIVERY_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          onClick={() => {
            setRows(null);
            setCursors([undefined]);
            setReload((n) => n + 1);
          }}
        >
          Refresh
        </button>
      </div>
      {rows === null ? (
        <p className="empty-note" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="empty-note">
          No deliveries yet. Events appear here once your bot receives them.
        </p>
      ) : (
        <div className="delivery-scroll">
          <table className="delivery-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Last code</th>
                <th scope="col">Error</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((delivery) => (
                <tr key={delivery.id}>
                  <td data-label="Time">
                    <time dateTime={delivery.createdAt} title={formatAbsolute(delivery.createdAt)}>
                      {formatTimestamp(delivery.createdAt)}
                    </time>
                  </td>
                  <td data-label="Event">
                    <code>{delivery.eventType}</code>
                  </td>
                  <td data-label="Status">
                    <span className="status-pill" data-status={delivery.status}>
                      {delivery.status}
                    </span>
                  </td>
                  <td data-label="Attempts">{delivery.attempts}</td>
                  <td data-label="Last code">{delivery.lastStatusCode ?? '–'}</td>
                  <td
                    data-label="Error"
                    className="delivery-error"
                    title={delivery.lastError ?? undefined}
                  >
                    {delivery.lastError ?? '–'}
                  </td>
                  <td className="delivery-actions">
                    {delivery.status !== 'pending' && (
                      <button
                        type="button"
                        className="button"
                        aria-label={`Redeliver ${delivery.eventType} event ${delivery.eventId}`}
                        onClick={() => void redeliver(delivery)}
                      >
                        Redeliver
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows !== null && (cursors.length > 1 || hasMore) && (
        <nav className="pager" aria-label="Delivery pages">
          <button
            type="button"
            className="button"
            disabled={cursors.length === 1}
            onClick={() => {
              setRows(null);
              setCursors((stack) => stack.slice(0, -1));
            }}
          >
            Newer
          </button>
          <span>Page {cursors.length}</span>
          <button
            type="button"
            className="button"
            disabled={!hasMore || !last}
            onClick={() => {
              setRows(null);
              setCursors((stack) => [...stack, last?.id]);
            }}
          >
            Older
          </button>
        </nav>
      )}
    </div>
  );
}
