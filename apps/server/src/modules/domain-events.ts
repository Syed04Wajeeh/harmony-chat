import type { DomainEventMap, DomainEventName } from './types.js';

type Handler<K extends DomainEventName> = (event: DomainEventMap[K]) => void | Promise<void>;

export interface DomainLogger {
  warn(obj: object, msg: string): void;
}

/**
 * In-process bus for reactions to things that already happened. `emit` is called after the
 * transaction committed and never waits for handlers: a slow or throwing handler is logged and
 * cannot fail or delay the request. With no handlers for an event it is a single map lookup.
 */
export class DomainEvents {
  private readonly handlers = new Map<DomainEventName, Set<Handler<never>>>();

  constructor(private readonly log: DomainLogger) {}

  on<K extends DomainEventName>(name: K, handler: Handler<K>): void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler);
    this.handlers.set(name, set);
  }

  emit<K extends DomainEventName>(name: K, event: DomainEventMap[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of set) {
      void (async () => {
        try {
          await (handler as Handler<K>)(event);
        } catch (err) {
          this.log.warn({ err, event: name }, 'domain event handler failed');
        }
      })();
    }
  }
}
