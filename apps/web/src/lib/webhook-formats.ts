import type { WebhookFormat, WebhookTemplate } from '@harmony/shared';

export interface FormatInfo {
  label: string;
  /** One line on how to point the sender at this webhook. */
  hint: string;
  /** A realistic sample body for the preview box. */
  sample: unknown;
  /** The header that names the event, for senders that put it there. */
  eventHeader?: string;
  /** Whether the sender can sign its requests with a shared secret. */
  signed?: boolean;
}

export const WEBHOOK_FORMAT_ORDER: readonly WebhookFormat[] = [
  'discord',
  'forgejo',
  'github',
  'alertmanager',
  'grafana',
  'watchtower',
  'generic',
  'template',
];

export const STARTER_TEMPLATE: WebhookTemplate = {
  content: '{{status | upper}}: {{name}}',
  embed: {
    title: '{{name}}',
    description: '{{message | default:"No details"}}',
    color: '#2ecc71',
    fields: [{ name: 'Host', value: '{{host.name | default:"unknown"}}', inline: true }],
  },
};

const repository = { full_name: 'lab/harmony', html_url: 'https://git.example.test/lab/harmony' };

export const FORMAT_INFO: Record<WebhookFormat, FormatInfo> = {
  discord: {
    label: 'Discord-compatible',
    hint: 'For senders that already speak Discord webhooks: content, embeds, username.',
    sample: { content: 'Deploy finished', embeds: [{ title: 'Build 42', color: 3066993 }] },
  },
  forgejo: {
    label: 'Forgejo / Gitea',
    hint: 'Add a Gitea-type webhook in the repository settings and paste the URL. Pushes, pull requests, issues, releases and Actions runs are posted.',
    eventHeader: 'X-Forgejo-Event',
    signed: true,
    sample: {
      ref: 'refs/heads/main',
      before: '1111111111111111111111111111111111111111',
      after: '2222222222222222222222222222222222222222',
      commits: [{ id: 'aaaaaaa1111', message: 'Fix the backoff', author: { name: 'Ada' } }],
      repository,
      sender: { login: 'ada' },
    },
  },
  github: {
    label: 'GitHub',
    hint: 'Add a webhook with content type application/json. Pushes, pull requests, issues, releases and workflow runs are posted.',
    eventHeader: 'X-GitHub-Event',
    signed: true,
    sample: {
      action: 'opened',
      number: 7,
      pull_request: {
        number: 7,
        title: 'Add presets',
        html_url: 'https://github.example.test/lab/harmony/pull/7',
        head: { ref: 'presets' },
        base: { ref: 'main' },
      },
      repository,
      sender: { login: 'ada' },
    },
  },
  alertmanager: {
    label: 'Prometheus Alertmanager',
    hint: 'Add a webhook_configs receiver whose url is this webhook URL.',
    sample: {
      status: 'firing',
      receiver: 'harmony',
      groupLabels: { alertname: 'HighLatency' },
      commonLabels: { alertname: 'HighLatency', severity: 'critical' },
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'HighLatency', instance: 'api-1:9100' },
          annotations: { summary: 'p99 latency is above 2s' },
        },
      ],
    },
  },
  grafana: {
    label: 'Grafana',
    hint: 'Add a contact point of type Webhook and paste the URL.',
    sample: {
      status: 'firing',
      title: '[FIRING:1] DiskFull (prod)',
      message: 'Disk usage is above 90%',
      alerts: [{ status: 'firing', labels: { alertname: 'DiskFull' }, annotations: {} }],
    },
  },
  watchtower: {
    label: 'Watchtower',
    hint: 'Set WATCHTOWER_NOTIFICATION_URL to a generic:// URL for this webhook, with template=json if you like.',
    sample: {
      title: 'Watchtower updates',
      message: 'Found new example/app:latest image\nStopping /app\nCreating /app',
    },
  },
  generic: {
    label: 'Generic JSON',
    hint: 'Any JSON body: well-known keys such as title, message and url are used, and the rest are listed as fields.',
    sample: { event: 'door_opened', state: 'on', friendly_name: 'Front door', battery: 91 },
  },
  template: {
    label: 'Custom template',
    hint: 'Map any JSON body to a message with {{path.to.field}} placeholders. No code runs.',
    sample: {
      name: 'Nightly backup',
      status: 'ok',
      message: '12 GB in 4 min',
      host: { name: 'nas' },
    },
  },
};
