const clockFormats = {
  '12h': new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }),
  '24h': new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
};
let clock = clockFormats['12h'];

/** Clock style for every timestamp; components that show one subscribe to the setting to redraw. */
export function setTimeFormat(format: '12h' | '24h'): void {
  clock = clockFormats[format];
}
const dayFull = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const dayShort = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const DAY_MS = 86_400_000;

export const isSameDay = (a: Date, b: Date) => startOfDay(a).getTime() === startOfDay(b).getTime();

function dayOffset(date: Date, now: Date): number {
  return Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY_MS);
}

export const formatClock = (iso: string) => clock.format(new Date(iso));
export const formatAbsolute = (iso: string) => full.format(new Date(iso));

/** "Today", "Yesterday" or a full date, for day separators. */
export function formatDayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const offset = dayOffset(date, now);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Yesterday';
  return dayFull.format(date);
}

/** Message header timestamp: "Today at 9:15 AM", "Yesterday at ...", else a short date and time. */
export function formatTimestamp(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const offset = dayOffset(date, now);
  if (offset === 0) return `Today at ${clock.format(date)}`;
  if (offset === 1) return `Yesterday at ${clock.format(date)}`;
  return `${dayShort.format(date)} ${clock.format(date)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
