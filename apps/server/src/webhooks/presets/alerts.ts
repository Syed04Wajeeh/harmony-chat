import type { LooseEmbed, LooseMessage } from '@harmony/shared';
import { COLORS, arr, brief, isObj, obj, plural, str, type Obj, type Preset } from './util.js';

/**
 * Prometheus Alertmanager (webhook receiver, payload version 4) and Grafana. Grafana's unified
 * alerting uses the same shape plus a few links, so one converter serves both; Grafana's legacy
 * alerting body (`ruleName`, `state`, `evalMatches`) has its own small branch.
 */

const SHOWN_ALERTS = 8;

function labelsText(labels: Obj, skip: readonly string[]): string {
  return Object.entries(labels)
    .filter(([key, value]) => !skip.includes(key) && str(value) !== undefined)
    .map(([key, value]) => `${key}=${str(value) ?? ''}`)
    .join(', ');
}

function severityColor(severity: string | undefined, firing: boolean): number {
  if (!firing) return COLORS.green;
  switch (severity?.toLowerCase()) {
    case 'critical':
    case 'page':
    case 'error':
      return COLORS.red;
    case 'warning':
    case 'warn':
      return COLORS.orange;
    case 'info':
    case 'none':
      return COLORS.blue;
    default:
      return COLORS.red;
  }
}

function alertLine(alert: Obj): string {
  const labels = obj(alert.labels);
  const notes = obj(alert.annotations);
  const name = str(labels.alertname) ?? str(labels.rulename) ?? 'alert';
  const where = str(labels.instance) ?? str(labels.pod) ?? str(labels.job);
  const status = str(alert.status) === 'resolved' ? 'resolved' : 'firing';
  const summary = str(notes.summary) ?? str(notes.description) ?? str(notes.message);
  return `${status === 'resolved' ? 'OK' : '!!'} ${name}${where ? ` @ ${where}` : ''}${summary ? ` - ${summary}` : ''}`;
}

function grouped(b: Obj, grafana: boolean): LooseMessage | null {
  const alerts = arr(b.alerts).filter(isObj);
  const status = str(b.status) === 'resolved' ? 'resolved' : 'firing';
  const firing = alerts.filter((a) => str(a.status) !== 'resolved').length;
  const common = obj(b.commonLabels);
  const group = obj(b.groupLabels);
  const commonNotes = obj(b.commonAnnotations);
  const name =
    str(group.alertname) ??
    str(common.alertname) ??
    str(obj(obj(alerts[0]).labels).alertname) ??
    'Alert';

  const prefix = status === 'firing' ? `FIRING:${String(firing || alerts.length)}` : 'RESOLVED';
  // Grafana composes its own title ("[FIRING:1] name (labels)"); use it when present.
  const title = (grafana ? str(b.title) : undefined) ?? `[${prefix}] ${name}`;

  const lines = alerts.slice(0, SHOWN_ALERTS).map(alertLine);
  if (alerts.length > SHOWN_ALERTS) lines.push(`and ${String(alerts.length - SHOWN_ALERTS)} more`);
  if (b.truncatedAlerts && typeof b.truncatedAlerts === 'number' && b.truncatedAlerts > 0) {
    lines.push(`${plural(b.truncatedAlerts, 'alert')} not included`);
  }

  const fields: NonNullable<LooseEmbed['fields']> = [];
  const shared = labelsText(common, ['alertname']);
  if (shared) fields.push({ name: 'Labels', value: shared });
  const note = str(commonNotes.summary) ?? str(commonNotes.description);
  if (note) fields.push({ name: 'Details', value: note });
  const first = obj(alerts[0]);
  if (grafana) {
    const dashboard = str(first.dashboardURL);
    const silence = str(first.silenceURL);
    if (dashboard) fields.push({ name: 'Dashboard', value: dashboard });
    if (silence) fields.push({ name: 'Silence', value: silence });
  }

  const message = grafana ? brief(str(b.message), 600) : undefined;
  const description = [message, ...lines].filter(Boolean).join('\n') || undefined;
  if (!alerts.length && !message && !str(b.title)) return null;
  return {
    embeds: [
      {
        title,
        url: (grafana ? str(first.generatorURL) : undefined) ?? str(b.externalURL),
        description,
        color: severityColor(
          str(common.severity) ?? str(obj(first.labels).severity),
          status === 'firing',
        ),
        timestamp:
          str(first.startsAt) && !str(first.startsAt)?.startsWith('0001')
            ? str(first.startsAt)
            : undefined,
        fields,
        footer: str(b.receiver),
      },
    ],
  };
}

export const alertmanager: Preset = (_headers, body) => grouped(obj(body), false);

/** Grafana's pre-unified alerting body: `{title, ruleName, state, message, ruleUrl, evalMatches}`. */
function grafanaLegacy(b: Obj): LooseMessage | null {
  const state = str(b.state) ?? 'alerting';
  const color =
    state === 'ok'
      ? COLORS.green
      : state === 'alerting'
        ? COLORS.red
        : state === 'no_data'
          ? COLORS.yellow
          : COLORS.grey;
  const matches = arr(b.evalMatches).filter(isObj).slice(0, 8);
  return {
    embeds: [
      {
        title: str(b.title) ?? str(b.ruleName) ?? 'Grafana alert',
        url: str(b.ruleUrl),
        description: brief(str(b.message), 600),
        color,
        fields: matches.map((m) => ({
          name: str(m.metric) ?? 'value',
          value: str(m.value) ?? '',
          inline: true,
        })),
      },
    ],
  };
}

export const grafana: Preset = (_headers, body) => {
  const b = obj(body);
  if (Array.isArray(b.alerts)) return grouped(b, true);
  if ('ruleName' in b || 'evalMatches' in b || 'state' in b) return grafanaLegacy(b);
  if (str(b.title) || str(b.message)) {
    return {
      embeds: [
        { title: str(b.title), description: brief(str(b.message), 600), color: COLORS.blue },
      ],
    };
  }
  return null;
};
