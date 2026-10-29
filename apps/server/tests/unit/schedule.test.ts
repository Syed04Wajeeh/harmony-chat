import { describe, expect, it } from 'vitest';
import { PutSchedulesBody, isValidCron, nextCronRun, nextRunAt, parseCron } from '@harmony/shared';

const at = (iso: string) => new Date(iso);
const next = (expression: string, after: string) => {
  const cron = parseCron(expression);
  if (!cron) throw new Error(`unparseable: ${expression}`);
  return nextCronRun(cron, at(after))?.toISOString() ?? null;
};

describe('cron parsing', () => {
  it('accepts lists, ranges, steps and the day-of-week 7', () => {
    for (const ok of ['* * * * *', '*/5 * * * *', '0 9-17 * * 1-5', '1,2,3 0 1 1 *', '0 0 * * 7']) {
      expect(isValidCron(ok), ok).toBe(true);
    }
  });

  it('rejects the wrong shape, out-of-range values and unsupported syntax', () => {
    for (const bad of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '@daily',
      'a * * * *',
      // Parses, but no such day exists: it would never run.
      '0 0 30 2 *',
    ]) {
      expect(isValidCron(bad), bad).toBe(false);
    }
  });
});

describe('next cron run (UTC)', () => {
  it('moves to the next matching minute and never returns the instant itself', () => {
    expect(next('*/15 * * * *', '2026-03-10T10:07:30Z')).toBe('2026-03-10T10:15:00.000Z');
    expect(next('*/15 * * * *', '2026-03-10T10:15:00Z')).toBe('2026-03-10T10:30:00.000Z');
    expect(next('* * * * *', '2026-03-10T10:07:59Z')).toBe('2026-03-10T10:08:00.000Z');
  });

  it('rolls over hours, days, months and years', () => {
    expect(next('30 9 * * *', '2026-03-10T09:30:00Z')).toBe('2026-03-11T09:30:00.000Z');
    expect(next('0 0 1 * *', '2026-03-10T00:00:00Z')).toBe('2026-04-01T00:00:00.000Z');
    expect(next('0 0 1 1 *', '2026-03-10T00:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(next('59 23 31 12 *', '2026-12-31T23:59:00Z')).toBe('2027-12-31T23:59:00.000Z');
  });

  it('handles leap days', () => {
    expect(next('0 12 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T12:00:00.000Z');
  });

  it('matches day-of-week, where 0 and 7 are both Sunday', () => {
    // 2026-03-10 is a Tuesday.
    expect(next('0 8 * * 1', '2026-03-10T00:00:00Z')).toBe('2026-03-16T08:00:00.000Z');
    expect(next('0 8 * * 0', '2026-03-10T00:00:00Z')).toBe('2026-03-15T08:00:00.000Z');
    expect(next('0 8 * * 7', '2026-03-10T00:00:00Z')).toBe('2026-03-15T08:00:00.000Z');
  });

  it('ORs day-of-month and day-of-week when both are restricted, like cron does', () => {
    // The 15th or any Monday: from Tue the 10th, the 15th (a Sunday) comes before Monday the 16th.
    expect(next('0 0 15 * 1', '2026-03-10T00:00:00Z')).toBe('2026-03-15T00:00:00.000Z');
    expect(next('0 0 15 * 1', '2026-03-15T00:00:00Z')).toBe('2026-03-16T00:00:00.000Z');
  });

  it('does not depend on the host time zone or on daylight saving transitions', () => {
    // Around the 2026 European and US DST changes the UTC wall clock is unaffected.
    expect(next('30 1 * * *', '2026-03-29T00:00:00Z')).toBe('2026-03-29T01:30:00.000Z');
    expect(next('30 2 * * *', '2026-03-08T00:00:00Z')).toBe('2026-03-08T02:30:00.000Z');
    expect(next('0 * * * *', '2026-10-25T00:30:00Z')).toBe('2026-10-25T01:00:00.000Z');
    expect(next('0 * * * *', '2026-10-25T01:00:00Z')).toBe('2026-10-25T02:00:00.000Z');
  });

  it('supports steps from a start value', () => {
    expect(next('5/20 * * * *', '2026-03-10T10:06:00Z')).toBe('2026-03-10T10:25:00.000Z');
    expect(next('5/20 * * * *', '2026-03-10T10:46:00Z')).toBe('2026-03-10T11:05:00.000Z');
  });
});

describe('next run with jitter', () => {
  const from = at('2026-03-10T10:00:00Z');

  it('adds the interval plus up to 10% (at most five seconds)', () => {
    expect(nextRunAt({ every: 60, cron: null }, from, () => 0).toISOString()).toBe(
      '2026-03-10T10:01:00.000Z',
    );
    expect(nextRunAt({ every: 60, cron: null }, from, () => 0.999999).getTime()).toBeLessThan(
      from.getTime() + 60_000 + 6000,
    );
    // Long intervals cap at five seconds.
    const long = nextRunAt({ every: 86_400, cron: null }, from, () => 0.999999).getTime();
    expect(long - from.getTime() - 86_400_000).toBeLessThanOrEqual(5000);
  });

  it('fires cron on its minute plus under two seconds', () => {
    const run = nextRunAt({ every: null, cron: '*/5 * * * *' }, from, () => 0.5);
    expect(run.toISOString()).toBe('2026-03-10T10:05:01.000Z');
  });

  it('throws for a cron that can never fire', () => {
    expect(() => nextRunAt({ every: null, cron: '0 0 30 2 *' }, from)).toThrow();
  });
});

describe('schedule validation', () => {
  const entry = { id: 'refresh', channelId: '12' };

  it('wants exactly one of every and cron', () => {
    expect(PutSchedulesBody.safeParse({ schedules: [{ ...entry, every: 60 }] }).success).toBe(true);
    expect(
      PutSchedulesBody.safeParse({ schedules: [{ ...entry, cron: '*/5 * * * *' }] }).success,
    ).toBe(true);
    expect(PutSchedulesBody.safeParse({ schedules: [entry] }).success).toBe(false);
    expect(
      PutSchedulesBody.safeParse({ schedules: [{ ...entry, every: 60, cron: '* * * * *' }] })
        .success,
    ).toBe(false);
  });

  it('bounds the interval above (the lower bound is server configuration)', () => {
    expect(PutSchedulesBody.safeParse({ schedules: [{ ...entry, every: 86_400 }] }).success).toBe(
      true,
    );
    expect(PutSchedulesBody.safeParse({ schedules: [{ ...entry, every: 86_401 }] }).success).toBe(
      false,
    );
    expect(PutSchedulesBody.safeParse({ schedules: [{ ...entry, every: 1.5 }] }).success).toBe(
      false,
    );
  });

  it('checks slugs, panel keys and cron syntax', () => {
    const bad = (extra: object) =>
      PutSchedulesBody.safeParse({ schedules: [{ ...entry, every: 60, ...extra }] }).success;
    expect(bad({ id: 'Has Space' })).toBe(false);
    expect(bad({ panelKey: 'Bad Key' })).toBe(false);
    expect(bad({ panelKey: 'dashboard' })).toBe(true);
    expect(
      PutSchedulesBody.safeParse({ schedules: [{ ...entry, cron: '61 * * * *' }] }).success,
    ).toBe(false);
  });
});
