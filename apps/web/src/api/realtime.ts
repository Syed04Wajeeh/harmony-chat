import { ModuleFrame, ServerFrame, type ClientFrame } from '@harmony/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** Delay before reconnect attempt `attempt` (0-based): exponential, capped, half of it jittered. */
export function backoffDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return ceiling / 2 + random() * (ceiling / 2);
}

type FrameListener = (frame: ServerFrame) => void;
type ModuleFrameListener = (frame: ModuleFrame) => void;
type StatusListener = (status: ConnectionStatus) => void;

/** A self-healing WebSocket: reconnects with backoff and reports status and parsed frames. */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private current: ConnectionStatus = 'connecting';
  private readonly frameListeners = new Set<FrameListener>();
  private readonly moduleListeners = new Set<ModuleFrameListener>();
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

  /** Frames that belong to modules (`<moduleId>.<name>`); the core protocol never uses these. */
  onModuleFrame(listener: ModuleFrameListener): () => void {
    this.moduleListeners.add(listener);
    return () => this.moduleListeners.delete(listener);
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
      const parsed = parseFrame(event.data);
      if (parsed?.core) this.frameListeners.forEach((listener) => listener(parsed.core));
      else if (parsed?.module) this.moduleListeners.forEach((listener) => listener(parsed.module));
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

type Parsed = { core: ServerFrame; module?: never } | { module: ModuleFrame; core?: never };

export function parseFrame(data: unknown): Parsed | null {
  if (typeof data !== 'string') return null;
  try {
    const json: unknown = JSON.parse(data);
    const core = ServerFrame.safeParse(json);
    if (core.success) return { core: core.data };
    const module = ModuleFrame.safeParse(json);
    return module.success ? { module: module.data } : null;
  } catch {
    return null;
  }
}

export function realtimeUrl(
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
}
