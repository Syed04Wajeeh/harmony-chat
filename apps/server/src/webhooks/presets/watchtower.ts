import type { LooseEmbed } from '@harmony/shared';
import { COLORS, arr, brief, isObj, obj, plural, str, type Obj, type Preset } from './util.js';

/**
 * Watchtower notifies through shoutrrr. Its `generic://` service posts either the raw message
 * (text/plain) or, with `template=json`, `{"message": "...", "title": "..."}`. Watchtower's own
 * JSON report template adds `report` (scanned, updated, failed, skipped, stale, fresh lists of
 * containers) and `entries` (log lines with a level). All three shapes are handled.
 */

function containers(list: unknown): string[] {
  return arr(list)
    .filter(isObj)
    .map((c) => str(c.name) ?? str(c.imageName) ?? 'container');
}

function colorFor(text: string, level: string | undefined): number {
  const probe = `${level ?? ''} ${text}`.toLowerCase();
  if (/\b(fatal|error|fail|failed|panic)\b/.test(probe)) return COLORS.red;
  if (/\bwarn(ing)?\b/.test(probe)) return COLORS.orange;
  if (/(updated|found new|stopping|creating|session done)/.test(probe)) return COLORS.green;
  return COLORS.blue;
}

function fromReport(b: Obj): LooseEmbed | null {
  const report = obj(b.report);
  const updated = containers(report.updated);
  const failed = containers(report.failed);
  const scanned = arr(report.scanned).length;
  const entries = arr(b.entries).filter(isObj);
  const fields: NonNullable<LooseEmbed['fields']> = [];
  if (updated.length)
    fields.push({ name: `Updated (${String(updated.length)})`, value: updated.join(', ') });
  if (failed.length)
    fields.push({ name: `Failed (${String(failed.length)})`, value: failed.join(', ') });
  const log = entries
    .slice(0, 8)
    .map((e) => str(e.message))
    .filter((m): m is string => m !== undefined)
    .join('\n');
  if (!fields.length && !log && !scanned) return null;
  const host = str(b.host);
  return {
    title:
      str(b.title) ??
      (failed.length
        ? `Watchtower: ${plural(failed.length, 'update')} failed`
        : updated.length
          ? `Watchtower updated ${plural(updated.length, 'container')}`
          : 'Watchtower scan finished'),
    description: scanned
      ? `${plural(scanned, 'container')} scanned${log ? `\n${log}` : ''}`
      : log || undefined,
    color: failed.length ? COLORS.red : updated.length ? COLORS.green : COLORS.blue,
    fields,
    footer: host,
  };
}

export const watchtower: Preset = (_headers, body) => {
  if (typeof body === 'string') {
    const text = body.trim();
    if (text === '') return null;
    return {
      embeds: [
        { title: 'Watchtower', description: brief(text, 1500), color: colorFor(text, undefined) },
      ],
    };
  }
  const b = obj(body);
  if ('report' in b || 'entries' in b) {
    const embed = fromReport(b);
    return embed ? { embeds: [embed] } : null;
  }
  const message = str(b.message) ?? str(b.text) ?? str(b.content);
  if (!message) return null;
  return {
    embeds: [
      {
        title: str(b.title) ?? 'Watchtower',
        description: brief(message, 1500),
        color: colorFor(message, str(b.level)),
      },
    ],
  };
};
