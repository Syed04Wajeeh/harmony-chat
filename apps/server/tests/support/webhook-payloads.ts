/**
 * Hand-written payloads in the shapes the services document for their webhooks (Forgejo and
 * Gitea, GitHub, Prometheus Alertmanager, Grafana, Watchtower). They are trimmed to the fields
 * the presets read, plus a few neighbours to prove unknown fields are ignored.
 */

const repository = {
  id: 7,
  name: 'harmony',
  full_name: 'lab/harmony',
  html_url: 'https://git.example.test/lab/harmony',
};
const sender = { id: 3, login: 'wajeeh', username: 'wajeeh' };

export const forgePush = {
  ref: 'refs/heads/main',
  before: '1111111111111111111111111111111111111111',
  after: '2222222222222222222222222222222222222222',
  compare_url: 'https://git.example.test/lab/harmony/compare/1111111...2222222',
  commits: [
    {
      id: 'aaaaaaa1111111111111111111111111111111aa',
      message: 'Fix the reconnect backoff\n\nLonger body that is not shown',
      url: 'https://git.example.test/lab/harmony/commit/aaaaaaa',
      author: { name: 'Wajeeh', username: 'wajeeh' },
    },
    {
      id: 'bbbbbbb2222222222222222222222222222222bb',
      message: 'Add a test',
      url: 'https://git.example.test/lab/harmony/commit/bbbbbbb',
      author: { name: 'Ada', username: 'ada' },
    },
  ],
  total_commits: 2,
  repository,
  pusher: { login: 'wajeeh' },
  sender,
};

export const forgePushBranchDeleted = {
  ref: 'refs/heads/old-work',
  before: '2222222222222222222222222222222222222222',
  after: '0000000000000000000000000000000000000000',
  commits: [],
  repository,
  sender,
};

export const forgePullRequestOpened = {
  action: 'opened',
  number: 12,
  pull_request: {
    number: 12,
    title: 'Add webhook presets',
    body: 'Adds presets for common services.',
    html_url: 'https://git.example.test/lab/harmony/pulls/12',
    merged: false,
    state: 'open',
    head: { ref: 'feature/presets' },
    base: { ref: 'main' },
  },
  repository,
  sender,
};

export const forgePullRequestMerged = {
  ...forgePullRequestOpened,
  action: 'closed',
  pull_request: { ...forgePullRequestOpened.pull_request, merged: true, state: 'closed' },
};

export const forgeIssueOpened = {
  action: 'opened',
  issue: {
    number: 40,
    title: 'Panels flicker on resize',
    body: 'Seen on mobile.',
    html_url: 'https://git.example.test/lab/harmony/issues/40',
  },
  repository,
  sender,
};

export const forgeIssueComment = {
  action: 'created',
  issue: { number: 40, title: 'Panels flicker on resize' },
  comment: {
    body: 'I can reproduce this.',
    html_url: 'https://git.example.test/lab/harmony/issues/40#issuecomment-9',
  },
  repository,
  sender,
};

export const forgeRelease = {
  action: 'published',
  release: {
    tag_name: 'v1.4.0',
    name: 'Version 1.4.0',
    body: 'Webhook presets.',
    prerelease: false,
    html_url: 'https://git.example.test/lab/harmony/releases/tag/v1.4.0',
  },
  repository,
  sender,
};

export const githubWorkflowRunFailed = {
  action: 'completed',
  workflow_run: {
    name: 'CI',
    display_title: 'Fix the reconnect backoff',
    conclusion: 'failure',
    status: 'completed',
    head_branch: 'main',
    html_url: 'https://github.example.test/lab/harmony/actions/runs/99',
  },
  repository,
  sender,
};

export const forgejoActionRunFailure = {
  action: 'failure',
  run: {
    id: 5,
    title: 'Build and test',
    html_url: 'https://git.example.test/lab/harmony/actions/runs/5',
    prettyref: 'main',
    workflow_id: 'ci.yml',
  },
  repository,
  sender,
};

export const alertmanagerFiring = {
  version: '4',
  groupKey: '{}:{alertname="HighLatency"}',
  truncatedAlerts: 0,
  status: 'firing',
  receiver: 'harmony',
  groupLabels: { alertname: 'HighLatency' },
  commonLabels: { alertname: 'HighLatency', severity: 'critical', job: 'api' },
  commonAnnotations: { summary: 'p99 latency is above 2s' },
  externalURL: 'https://alerts.example.test',
  alerts: [
    {
      status: 'firing',
      labels: {
        alertname: 'HighLatency',
        severity: 'critical',
        instance: 'api-1:9100',
        job: 'api',
      },
      annotations: { summary: 'p99 latency is above 2s on api-1' },
      startsAt: '2026-10-22T08:15:30.000Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'https://prom.example.test/graph?g0.expr=latency',
      fingerprint: 'abc123',
    },
    {
      status: 'firing',
      labels: {
        alertname: 'HighLatency',
        severity: 'critical',
        instance: 'api-2:9100',
        job: 'api',
      },
      annotations: { summary: 'p99 latency is above 2s on api-2' },
      startsAt: '2026-10-22T08:16:00.000Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'https://prom.example.test/graph?g0.expr=latency',
      fingerprint: 'def456',
    },
  ],
};

export const alertmanagerResolved = {
  ...alertmanagerFiring,
  status: 'resolved',
  commonLabels: { alertname: 'HighLatency', severity: 'warning' },
  alerts: [
    {
      ...alertmanagerFiring.alerts[0],
      status: 'resolved',
      endsAt: '2026-10-22T08:40:00.000Z',
    },
  ],
};

export const grafanaUnified = {
  receiver: 'harmony',
  status: 'firing',
  orgId: 1,
  title: '[FIRING:1] DiskFull (prod)',
  state: 'alerting',
  message: '**Firing**\n\nDisk usage is above 90%',
  externalURL: 'https://grafana.example.test/',
  groupLabels: { alertname: 'DiskFull' },
  commonLabels: { alertname: 'DiskFull', severity: 'warning', env: 'prod' },
  commonAnnotations: {},
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'DiskFull', severity: 'warning', env: 'prod' },
      annotations: { summary: 'Disk usage is above 90%' },
      startsAt: '2026-10-22T09:00:00Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'https://grafana.example.test/alerting/grafana/abc/view',
      silenceURL: 'https://grafana.example.test/alerting/silence/new?alertmanager=grafana',
      dashboardURL: 'https://grafana.example.test/d/xyz',
      valueString: '[ var=A value=93 ]',
    },
  ],
};

export const grafanaLegacy = {
  title: '[Alerting] Disk usage',
  ruleName: 'Disk usage',
  state: 'alerting',
  message: 'Disk usage is high',
  ruleUrl: 'https://grafana.example.test/d/xyz?editPanel=2',
  evalMatches: [{ metric: 'sda1', value: 93, tags: null }],
};

/** `generic://` with `template=json`: shoutrrr posts the message under `message`. */
export const watchtowerJson = {
  title: 'Watchtower updates on docker-host',
  message:
    'Found new lscr.io/linuxserver/jellyfin:latest image (4f5e6a7b8c9d)\nStopping /jellyfin\nCreating /jellyfin',
};

export const watchtowerReport = {
  title: 'Watchtower updates on docker-host',
  host: 'docker-host',
  report: {
    scanned: [{ name: 'jellyfin' }, { name: 'ntfy' }, { name: 'n8n' }],
    updated: [{ name: 'jellyfin', imageName: 'lscr.io/linuxserver/jellyfin:latest' }],
    failed: [],
  },
  entries: [{ level: 'info', message: 'Found new image for jellyfin' }],
};

export const watchtowerText =
  'Found new lscr.io/linuxserver/jellyfin:latest image\nStopping /jellyfin';

export const homeAssistant = {
  event: 'door_opened',
  entity_id: 'binary_sensor.front_door',
  state: 'on',
  friendly_name: 'Front door',
  attributes: { device_class: 'door', battery: 91 },
  time_fired: '2026-10-22T07:00:00+00:00',
};
