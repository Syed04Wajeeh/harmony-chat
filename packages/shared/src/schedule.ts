import { z } from 'zod';
import { Id } from './chat.js';
import { PanelSlug } from './components.js';

export const SCHEDULE_MIN_EVERY_SECONDS = 60;
export const SCHEDULE_MAX_EVERY_SECONDS = 86_400;
export const MAX_SCHEDULES_PER_BOT_PER_GUILD = 20;
export const MAX_SCHEDULES_PER_REQUEST = 200;

/* Cron: five fields (minute hour day-of-month month day-of-week), always UTC. */

interface Field {
  /** Allowed values, sorted. */
  values: number[];
  /** True when the field was `*` (or `*` with a step of 1), which matters for day matching. */
  any: boolean;
}

export interface CronSchedule {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
}

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function parseField(text: string, [min, max]: readonly [number, number]): Field | null {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const base = match[1] ?? '';
    const stepText = match[2];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;
    let from: number;
    let to: number;
    if (base === '*') {
      from = min;
      to = max;
      if (step === 1) any = true;
    } else if (base.includes('-')) {
      [from, to] = base.split('-').map(Number) as [number, number];
    } else {
      from = Number(base);
      // `5/10` means "from 5, every 10", up to the top of the range.
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return { values: [...values].sort((a, b) => a - b), any };
}

/** Parses `m h dom mon dow`: numbers, `*`, lists, ranges and steps. No names, no `@` macros. */
export function parseCron(expression: string): CronSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((part, index) => parseField(part, RANGES[index] ?? [0, 0]));
  const [minute, hour, dayOfMonth, month, dayOfWeekRaw] = fields;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeekRaw) return null;
  // 7 is Sunday too.
  const dayOfWeek: Field = {
    any: dayOfWeekRaw.any,
    values: [...new Set(dayOfWeekRaw.values.map((value) => value % 7))].sort((a, b) => a - b),
  };
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function dayMatches(cron: CronSchedule, date: Date): boolean {
  const dom = cron.dayOfMonth.values.includes(date.getUTCDate());
  const dow = cron.dayOfWeek.values.includes(date.getUTCDay());
  // Standard cron: when both are restricted, either one matching is enough.
  if (!cron.dayOfMonth.any && !cron.dayOfWeek.any) return dom || dow;
  return dom && dow;
}

/** The first matching minute strictly after `after`, or null if none within four years. */
export function nextCronRun(cron: CronSchedule, after: Date): Date | null {
  const next = (values: number[], from: number) => values.find((value) => value >= from);
  const date = new Date(after.getTime());
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(date.getUTCMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 86_400_000;
  while (date.getTime() <= limit) {
    if (!cron.month.values.includes(date.getUTCMonth() + 1)) {
      date.setUTCMonth(date.getUTCMonth() + 1, 1);
      date.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, date)) {
      date.setUTCDate(date.getUTCDate() + 1);
      date.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const hour = next(cron.hour.values, date.getUTCHours());
    if (hour === undefined) {
      date.setUTCDate(date.getUTCDate() + 1);
      date.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (hour !== date.getUTCHours()) date.setUTCHours(hour, 0, 0, 0);
    const minute = next(cron.minute.values, date.getUTCMinutes());
    if (minute === undefined) {
      date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    date.setUTCMinutes(minute, 0, 0);
    return date;
  }
  return null;
}

export const isValidCron = (expression: string): boolean => {
  const cron = parseCron(expression);
  return cron !== null && nextCronRun(cron, new Date()) !== null;
};

/** What a schedule fires on: a fixed interval or a cron expression. */
export interface Cadence {
  every: number | null;
  cron: string | null;
}

/**
 * When a schedule fires after `from`. An interval counts from `from` and gets up to 10% jitter
 * (at most five seconds) so that many schedules registered together do not fire together; cron
 * fires on its minute plus up to two seconds. `random` returns [0, 1).
 */
export function nextRunAt(cadence: Cadence, from: Date, random: () => number = Math.random): Date {
  if (cadence.every !== null) {
    const jitter = random() * Math.min(cadence.every * 100, 5000);
    return new Date(from.getTime() + cadence.every * 1000 + jitter);
  }
  const cron = cadence.cron === null ? null : parseCron(cadence.cron);
  const next = cron ? nextCronRun(cron, from) : null;
  if (!next) throw new Error('schedule has no next run');
  return new Date(next.getTime() + random() * 2000);
}

/* Wire shapes */

export const ScheduleSlug = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,31}$/,
    'Use 1-32 lowercase letters, digits, hyphens or underscores',
  );

export const ScheduleEntry = z
  .object({
    id: ScheduleSlug,
    channelId: Id,
    /** Seconds between runs. Exactly one of `every` and `cron`. */
    every: z.number().int().max(SCHEDULE_MAX_EVERY_SECONDS).optional(),
    /** Five-field cron expression, evaluated in UTC. */
    cron: z.string().trim().max(100).optional(),
    /** The panel a refresh is for; the bot answers with `update_panel` for it. */
    panelKey: PanelSlug.optional(),
  })
  .refine((entry) => (entry.every === undefined) !== (entry.cron === undefined), {
    message: 'Give exactly one of every and cron',
    path: ['every'],
  })
  .refine((entry) => entry.cron === undefined || isValidCron(entry.cron), {
    message: 'Not a valid five-field cron expression',
    path: ['cron'],
  });
export type ScheduleEntry = z.infer<typeof ScheduleEntry>;

/** The minimum interval is checked server-side because tests and small installs lower it. */
export const PutSchedulesBody = z.object({
  schedules: z.array(ScheduleEntry).max(MAX_SCHEDULES_PER_REQUEST),
});
export type PutSchedulesBody = z.infer<typeof PutSchedulesBody>;

export const SCHEDULE_STATUSES = ['ok', 'failed', 'skipped'] as const;

export const Schedule = z.object({
  /** Row id, for pausing and deleting. */
  rowId: Id,
  id: ScheduleSlug,
  botId: Id,
  guildId: Id,
  channelId: Id,
  every: z.number().int().nullable(),
  cron: z.string().nullable(),
  panelKey: z.string().nullable(),
  paused: z.boolean(),
  nextRunAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(),
  lastStatus: z.enum(SCHEDULE_STATUSES).nullable(),
  lastError: z.string().nullable(),
});
export type Schedule = z.infer<typeof Schedule>;
export const ListSchedulesResponse = z.object({ schedules: z.array(Schedule) });
export const ScheduleParams = z.object({ scheduleId: Id });
export const UpdateScheduleBody = z.object({ paused: z.boolean() });
export type UpdateScheduleBody = z.infer<typeof UpdateScheduleBody>;
