import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { fetchMessages } from '../api/client.js';
import type { ConnectionStatus, RealtimeClient } from '../api/realtime.js';
import { chatReducer, initialChatState, lastSeenId } from './messageState.js';

export function useChannelMessages(
  channelId: string,
  client: RealtimeClient,
  status: ConnectionStatus,
) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const loadLatest = useCallback(
    (signal: AbortSignal) => {
      fetchMessages(channelId, { signal })
        .then((page) => {
          setLoadError(null);
          dispatch({ type: 'loaded', ...page });
        })
        .catch((error: unknown) => {
          if (!signal.aborted)
            setLoadError(error instanceof Error ? error.message : 'Failed to load');
        });
    },
    [channelId],
  );

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: 'reset' });
    loadLatest(controller.signal);
    return () => controller.abort();
  }, [loadLatest]);

  // (Re)subscribe whenever the socket opens, resuming from the newest message we hold.
  useEffect(() => {
    if (status !== 'open') return;
    client.send({
      type: 'subscribe',
      channelId,
      lastSeenId: lastSeenId(stateRef.current.messages),
    });
    return () => {
      client.send({ type: 'unsubscribe', channelId });
    };
  }, [client, status, channelId]);

  useEffect(() => {
    if (status !== 'open') dispatch({ type: 'failed' });
  }, [status]);

  useEffect(() => {
    const controller = new AbortController();
    const off = client.onFrame((frame) => {
      switch (frame.type) {
        case 'message.created':
          if (frame.message.channelId === channelId) {
            dispatch({ type: 'received', messages: [frame.message], nonce: frame.nonce });
          }
          break;
        case 'ack':
          if (frame.message.channelId === channelId) {
            dispatch({ type: 'acked', nonce: frame.nonce, message: frame.message });
          }
          break;
        case 'backfill':
          if (frame.channelId !== channelId) break;
          dispatch({ type: 'received', messages: frame.messages });
          // Too many missed messages to splice in: refetch the newest page instead.
          if (frame.hasMore) {
            dispatch({ type: 'reset' });
            loadLatest(controller.signal);
          }
          break;
        case 'error':
          if (frame.nonce) dispatch({ type: 'failed', nonce: frame.nonce });
          break;
        case 'hello':
          break;
      }
    });
    return () => {
      off();
      controller.abort();
    };
  }, [client, channelId, loadLatest]);

  const loadOlder = useCallback(async () => {
    const { messages, hasMore } = stateRef.current;
    const oldest = messages[0];
    if (!oldest || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(channelId, { before: oldest.id });
      dispatch({ type: 'older', ...page });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load');
    } finally {
      setLoadingOlder(false);
    }
  }, [channelId, loadingOlder]);

  const send = useCallback(
    (content: string): boolean => {
      const nonce = crypto.randomUUID();
      if (!client.send({ type: 'message.send', channelId, content, nonce })) return false;
      dispatch({
        type: 'queued',
        item: { nonce, content, createdAt: new Date().toISOString(), status: 'pending' },
      });
      return true;
    },
    [client, channelId],
  );

  return { ...state, loadingOlder, loadError, loadOlder, send };
}
