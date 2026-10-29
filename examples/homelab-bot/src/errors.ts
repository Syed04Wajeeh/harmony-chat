/**
 * Errors the bot raises on purpose. `message` is safe to show to a person in chat: it never
 * contains an address, a key or a response body copied from a backend.
 */
export class BotError extends Error {
  readonly kind: 'not_allowed' | 'not_found' | 'unreachable' | 'refused' | 'failed' | 'cooldown';
  constructor(kind: BotError['kind'], message: string) {
    super(message);
    this.name = 'BotError';
    this.kind = kind;
  }
}

export const notAllowed = (what: string) =>
  new BotError('not_allowed', `${what} is not something this bot controls.`);

/** Collapses a thrown value to text that is safe to show, whatever was thrown. */
export function describeError(error: unknown): string {
  if (error instanceof BotError) return error.message;
  return 'Something went wrong; the details are in the bot log.';
}

/** Strips control characters and clamps a string that came from a backend or a person. */
export function clean(value: unknown, max = 200): string {
  const out = (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** A person's display name made safe to put inside a chat message (no mentions, no markup). */
export const safeName = (value: string): string =>
  clean(value, 40).replace(/[*_`~|<>@[\]()\\#]/g, '') || 'someone';
