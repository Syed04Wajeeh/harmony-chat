import { ServerFrame, type ClientFrame } from '@harmony/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** Delay before reconnect attempt `attempt` (0-based): exponential, capped, half of it jittered. */
export function backoffDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return ceiling / 2 + random() * (ceiling / 2);
}

type FrameListener = (frame: ServerFrame) => void;
type StatusListener = (status: ConnectionStatus) => void;

/** A self-healing WebSocket: reconnects with backoff and reports status and parsed frames. */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private current: ConnectionStatus = 'connecting';
  private readonly frameListeners = new Set<FrameListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(private readonly url: string) {}

  get status(): ConnectionStatus {
    return this.current;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  send(frame: ClientFrame): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private open(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.setStatus('open');
    });
    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      const frame = parseFrame(event.data);
      if (frame) this.frameListeners.forEach((listener) => listener(frame));
    });
    socket.addEventListener('close', () => {
      if (this.stopped || this.socket !== socket) return;
      this.setStatus('reconnecting');
      this.timer = setTimeout(() => this.open(), backoffDelay(this.attempt++));
    });
  }

  private setStatus(status: ConnectionStatus): void {
    this.current = status;
    this.statusListeners.forEach((listener) => listener(status));
  }
}

function parseFrame(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null;
  try {
    const result = ServerFrame.safeParse(JSON.parse(data));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function realtimeUrl(
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
}
