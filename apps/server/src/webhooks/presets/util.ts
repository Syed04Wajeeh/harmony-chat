import { truncate, type LooseMessage } from '@harmony/shared';

/** Lower-cased header names, as Node delivers them. */
export type Headers = Readonly<Record<string, string | undefined>>;

/** A preset reads a service's own payload and says what to post, or null to ignore it. */
export type Preset = (headers: Headers, body: unknown) => LooseMessage | null;

export const COLORS = {
  green: 0x2ecc71,
  red: 0xe74c3c,
  orange: 0xe67e22,
  yellow: 0xf1c40f,
  blue: 0x3498db,
  purple: 0x9b59b6,
  teal: 0x1abc9c,
  grey: 0x95a5a6,
} as const;

export type Obj = Record<string, unknown>;

export const isObj = (value: unknown): value is Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** An object, or an empty one, so chained reads never throw on a surprising payload. */
export const obj = (value: unknown): Obj => (isObj(value) ? value : {});

export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A non-empty string, or a number or boolean as text; anything else is undefined. */
export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export const firstLine = (text: string | undefined): string =>
  (text ?? '').split('\n', 1)[0]?.trim() ?? '';

/** Descriptions stay short: the link is one click away. */
export const brief = (text: string | undefined, max = 300): string | undefined => {
  const value = text?.trim();
  return value ? truncate(value, max) : undefined;
};

export const code = (text: string): string => `\`${text.replaceAll('`', "'")}\``;

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;
