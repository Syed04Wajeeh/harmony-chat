import { describe, expect, it } from 'vitest';
import { EmbedsInput, normalizeMessage } from '@harmony/shared';
import { PRESETS } from '../../src/webhooks/presets/index.js';
import * as p from '../support/webhook-payloads.js';

/** The pipeline the live endpoint runs: preset, then clamping. */
const run = (name: keyof typeof PRESETS, headers: Record<string, string>, body: unknown) => {
  const loose = PRESETS[name](headers, body);
  return loose ? normalizeMessage(loose) : null;
};
const embed = (name: keyof typeof PRESETS, headers: Record<string, string>, body: unknown) =>
  run(name, headers, body)?.embeds[0];

describe('forgejo and github presets', () => {
  const forgejo = { 'x-forgejo-event': 'push' };

  it('summarises a push with commits, compare link and author', () => {
    const e = embed('forgejo', forgejo, p.forgePush);
    expect(e?.title).toBe('[lab/harmony:main] 2 new commits');
    expect(e?.url).toBe(p.forgePush.compare_url);
    expect(e?.description).toContain('`aaaaaaa` Fix the reconnect backoff - Wajeeh');
    expect(e?.description).not.toContain('Longer body');
    expect(e?.author?.name).toBe('wajeeh');
    expect(e?.footer?.text).toBe('lab/harmony');
  });

  it('reports a deleted branch', () => {
    const e = embed('forgejo', forgejo, p.forgePushBranchDeleted);
    expect(e?.title).toBe('[lab/harmony] branch old-work deleted');
  });

  it('handles pull requests: opened, merged and quiet actions', () => {
    const opened = embed('forgejo', { 'x-gitea-event': 'pull_request' }, p.forgePullRequestOpened);
    expect(opened?.title).toBe('[lab/harmony] Pull request opened: #12 Add webhook presets');
    expect(opened?.fields?.[0]).toMatchObject({ name: 'Branch', value: 'feature/presets -> main' });
    const merged = embed('github', { 'x-github-event': 'pull_request' }, p.forgePullRequestMerged);
    expect(merged?.title).toContain('Pull request merged');
    expect(merged?.color).toBe(0x9b59b6);
    expect(
      run(
        'github',
        { 'x-github-event': 'pull_request' },
        { ...p.forgePullRequestOpened, action: 'labeled' },
      ),
    ).toBeNull();
  });

  it('handles issues, comments and releases', () => {
    expect(embed('forgejo', { 'x-forgejo-event': 'issues' }, p.forgeIssueOpened)?.title).toBe(
      '[lab/harmony] Issue opened: #40 Panels flicker on resize',
    );
    const comment = embed('github', { 'x-github-event': 'issue_comment' }, p.forgeIssueComment);
    expect(comment?.description).toBe('I can reproduce this.');
    expect(
      run(
        'github',
        { 'x-github-event': 'issue_comment' },
        { ...p.forgeIssueComment, action: 'deleted' },
      ),
    ).toBeNull();
    const rel = embed('github', { 'x-github-event': 'release' }, p.forgeRelease);
    expect(rel?.title).toBe('[lab/harmony] Release published: Version 1.4.0');
    expect(
      run('github', { 'x-github-event': 'release' }, { ...p.forgeRelease, action: 'created' }),
    ).toBeNull();
  });

  it('handles workflow runs and Forgejo action runs', () => {
    const wf = embed('github', { 'x-github-event': 'workflow_run' }, p.githubWorkflowRunFailed);
    expect(wf?.title).toBe('[lab/harmony] Workflow CI: failure');
    expect(wf?.color).toBe(0xe74c3c);
    const act = embed(
      'forgejo',
      { 'x-forgejo-event': 'action_run_failure' },
      p.forgejoActionRunFailure,
    );
    expect(act?.title).toBe('[lab/harmony] Action run failure: Build and test');
    expect(act?.url).toContain('/actions/runs/5');
  });

  it('answers ping, ignores chatty events and says one line for unknown ones', () => {
    expect(
      embed(
        'github',
        { 'x-github-event': 'ping' },
        { zen: 'Keep it logically awesome.', repository: p.forgePush.repository },
      )?.title,
    ).toContain('Webhook connected');
    expect(run('github', { 'x-github-event': 'check_run' }, p.forgePush)).toBeNull();
    const star = run(
      'github',
      { 'x-github-event': 'star' },
      { action: 'created', repository: p.forgePush.repository, sender: p.forgePush.sender },
    );
    expect(star?.content).toBe('[lab/harmony] star (created) by wajeeh');
  });

  it('infers the event from the payload when the header is missing', () => {
    expect(embed('forgejo', {}, p.forgePush)?.title).toContain('new commits');
    expect(embed('github', {}, p.forgeRelease)?.title).toContain('Release published');
    expect(run('github', {}, { hello: 'world' })).toBeNull();
  });

  it('survives hostile shapes', () => {
    expect(() => run('github', { 'x-github-event': 'push' }, null)).not.toThrow();
    expect(() =>
      run('forgejo', { 'x-forgejo-event': 'pull_request' }, { pull_request: 'nope', number: [] }),
    ).not.toThrow();
    const mention = embed(
      'github',
      { 'x-github-event': 'issues' },
      {
        ...p.forgeIssueOpened,
        issue: {
          ...p.forgeIssueOpened.issue,
          title: '@everyone look',
          html_url: 'javascript:alert(1)',
        },
      },
    );
    expect(mention?.title).not.toMatch(/@everyone/);
    expect(mention?.url).toBeUndefined();
  });

  it('limits a very long commit list', () => {
    const commits = Array.from({ length: 200 }, (_, i) => ({
      id: `${i}`.padStart(40, 'a'),
      message: `commit ${i}`,
    }));
    const e = embed('forgejo', forgejo, { ...p.forgePush, commits, total_commits: 200 });
    expect(e?.description?.split('\n')).toHaveLength(6);
    expect(e?.description).toContain('and 195 more');
  });
});

describe('alertmanager preset', () => {
  it('summarises a firing group', () => {
    const e = embed('alertmanager', {}, p.alertmanagerFiring);
    expect(e?.title).toBe('[FIRING:2] HighLatency');
    expect(e?.color).toBe(0xe74c3c);
    expect(e?.description).toContain(
      '!! HighLatency @ api-1:9100 - p99 latency is above 2s on api-1',
    );
    expect(e?.fields?.find((f) => f.name === 'Labels')?.value).toContain('severity=critical');
    expect(e?.url).toBe('https://alerts.example.test');
    expect(e?.timestamp).toBe('2026-10-22T08:15:30.000Z');
  });

  it('summarises a resolved group in green', () => {
    const e = embed('alertmanager', {}, p.alertmanagerResolved);
    expect(e?.title).toBe('[RESOLVED] HighLatency');
    expect(e?.color).toBe(0x2ecc71);
    expect(e?.description).toMatch(/^OK HighLatency/);
  });

  it('caps a huge group and ignores an empty one', () => {
    const alerts = Array.from({ length: 300 }, (_, i) => ({
      status: 'firing',
      labels: { alertname: 'X', instance: `h${i}` },
    }));
    const e = embed('alertmanager', {}, { ...p.alertmanagerFiring, alerts, truncatedAlerts: 4 });
    expect(e?.description?.split('\n').length).toBeLessThanOrEqual(10);
    expect(run('alertmanager', {}, {})).toBeNull();
  });
});

describe('grafana preset', () => {
  it('uses the unified alerting title, message and links', () => {
    const e = embed('grafana', {}, p.grafanaUnified);
    expect(e?.title).toBe('[FIRING:1] DiskFull (prod)');
    expect(e?.description).toContain('Disk usage is above 90%');
    expect(e?.color).toBe(0xe67e22);
    expect(e?.fields?.map((f) => f.name)).toEqual(expect.arrayContaining(['Dashboard', 'Silence']));
    expect(e?.url).toContain('/alerting/grafana/');
  });

  it('understands the legacy body', () => {
    const e = embed('grafana', {}, p.grafanaLegacy);
    expect(e?.title).toBe('[Alerting] Disk usage');
    expect(e?.fields?.[0]).toMatchObject({ name: 'sda1', value: '93' });
    expect(embed('grafana', {}, { ...p.grafanaLegacy, state: 'ok' })?.color).toBe(0x2ecc71);
  });
});

describe('watchtower preset', () => {
  it('reads the shoutrrr JSON body', () => {
    const e = embed('watchtower', {}, p.watchtowerJson);
    expect(e?.title).toBe('Watchtower updates on docker-host');
    expect(e?.description).toContain('Found new');
    expect(e?.color).toBe(0x2ecc71);
  });

  it('reads the plain text body', () => {
    const e = embed('watchtower', { 'content-type': 'text/plain' }, p.watchtowerText);
    expect(e?.title).toBe('Watchtower');
    expect(e?.description).toContain('Stopping /jellyfin');
    expect(run('watchtower', {}, '   ')).toBeNull();
  });

  it('reads the report body', () => {
    const e = embed('watchtower', {}, p.watchtowerReport);
    expect(e?.fields?.[0]).toMatchObject({ name: 'Updated (1)', value: 'jellyfin' });
    expect(e?.description).toContain('3 containers scanned');
    expect(e?.footer?.text).toBe('docker-host');
  });

  it('colours failures red', () => {
    expect(embed('watchtower', {}, { message: 'Error: unable to pull image' })?.color).toBe(
      0xe74c3c,
    );
  });
});

describe('generic preset', () => {
  it('pretty-prints a Home Assistant style body', () => {
    const e = embed('generic', {}, p.homeAssistant);
    expect(e?.title).toBe('door_opened');
    expect(e?.fields?.map((f) => f.name)).toEqual([
      'entity_id',
      'state',
      'friendly_name',
      'attributes',
      'time_fired',
    ]);
    expect(e?.fields?.find((f) => f.name === 'attributes')?.value).toBe(
      '{"device_class":"door","battery":91}',
    );
  });

  it('takes well-known keys for text, link and status colour', () => {
    const e = embed(
      'generic',
      {},
      { title: 'Backup', message: 'finished', url: 'https://example.test/b/1', status: 'success' },
    );
    expect(e).toMatchObject({
      title: 'Backup',
      description: 'finished',
      url: 'https://example.test/b/1',
      color: 0x2ecc71,
    });
    expect(e?.fields).toEqual([{ name: 'status', value: 'success', inline: true }]);
  });

  it('truncates long values, caps fields, and handles odd bodies', () => {
    const big = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v'.repeat(5000)]),
    );
    const e = embed('generic', {}, big);
    expect(e?.fields).toHaveLength(10);
    expect(e?.fields?.[0]?.value.length).toBeLessThanOrEqual(200);
    expect(run('generic', {}, {})).toBeNull();
    expect(run('generic', {}, 'plain text')?.content).toBe('plain text');
    expect(run('generic', {}, [1, 2, 3])?.content).toContain('```json');
    expect(run('generic', {}, null)).toBeNull();
  });
});

describe('preset output', () => {
  it('always satisfies the webhook embed schema', () => {
    const cases: [keyof typeof PRESETS, Record<string, string>, unknown][] = [
      ['forgejo', { 'x-forgejo-event': 'push' }, p.forgePush],
      ['github', { 'x-github-event': 'pull_request' }, p.forgePullRequestMerged],
      ['alertmanager', {}, p.alertmanagerFiring],
      ['grafana', {}, p.grafanaUnified],
      ['watchtower', {}, p.watchtowerReport],
      ['generic', {}, p.homeAssistant],
    ];
    for (const [name, headers, body] of cases) {
      const message = run(name, headers, body);
      expect(message, name).not.toBeNull();
      expect(EmbedsInput.safeParse(message?.embeds).success, name).toBe(true);
    }
  });
});
