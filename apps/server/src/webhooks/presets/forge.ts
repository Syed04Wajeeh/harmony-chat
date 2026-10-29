import type { LooseEmbed, LooseMessage } from '@harmony/shared';
import {
  COLORS,
  arr,
  brief,
  code,
  firstLine,
  isObj,
  obj,
  plural,
  str,
  type Headers,
  type Obj,
  type Preset,
} from './util.js';

/**
 * Forgejo, Gitea and GitHub send the same event vocabulary in nearly the same shapes, so one
 * converter serves the three presets. Shapes follow each project's webhook documentation.
 */

/** Events too chatty to post by default: a build produces several of these per run. */
const NOISY_EVENTS = new Set([
  'workflow_job',
  'check_run',
  'check_suite',
  'status',
  'deployment',
  'deployment_status',
  'watch',
  'repository_dispatch',
]);

/** Actions that carry no news worth a message. */
const QUIET_ACTIONS = new Set([
  'labeled',
  'unlabeled',
  'assigned',
  'unassigned',
  'milestoned',
  'demilestoned',
  'locked',
  'unlocked',
  'review_requested',
  'review_request_removed',
]);

const ZEROS = /^0+$/;

function eventOf(flavor: 'github' | 'forgejo', headers: Headers, b: Obj): string | undefined {
  const order =
    flavor === 'github'
      ? ['x-github-event', 'x-forgejo-event', 'x-gitea-event']
      : ['x-forgejo-event', 'x-gitea-event', 'x-github-event'];
  for (const name of order) {
    const value = headers[name];
    if (value) return value.toLowerCase();
  }
  // No header (a hand-made request): guess from the shape.
  if ('workflow_run' in b) return 'workflow_run';
  if ('pull_request' in b) return 'pull_request';
  if ('release' in b) return 'release';
  if ('issue' in b) return 'comment' in b ? 'issue_comment' : 'issues';
  if ('commits' in b || 'ref' in b) return 'push';
  return undefined;
}

const label = (text: string): string => text.replaceAll('_', ' ');

function ref(value: string | undefined): { name: string; isTag: boolean } {
  const text = value ?? '';
  return { name: text.replace(/^refs\/(heads|tags)\//, ''), isTag: text.startsWith('refs/tags/') };
}

function push(b: Obj, repo: string): LooseEmbed {
  const { name, isTag } = ref(str(b.ref));
  const kind = isTag ? 'tag' : 'branch';
  const after = str(b.after) ?? '';
  const deleted = b.deleted === true || (after !== '' && ZEROS.test(after));
  const created = b.created === true || ZEROS.test(str(b.before) ?? 'x');
  const commits = arr(b.commits).filter(isObj);
  const count = typeof b.total_commits === 'number' ? b.total_commits : commits.length;
  const head = obj(b.head_commit);

  let title: string;
  if (deleted) title = `[${repo}] ${kind} ${name} deleted`;
  else if (created && commits.length === 0) title = `[${repo}] new ${kind} ${name}`;
  else if (isTag) title = `[${repo}] tag ${name} pushed`;
  else title = `[${repo}:${name}] ${plural(Math.max(count, 1), 'new commit')}`;

  const shown = commits.slice(0, 5).map((commit) => {
    const id = (str(commit.id) ?? '').slice(0, 7);
    const author = str(obj(commit.author).name) ?? str(obj(commit.author).username);
    const line = firstLine(str(commit.message));
    return `${id ? `${code(id)} ` : ''}${line}${author ? ` - ${author}` : ''}`;
  });
  const extra = count - shown.length;
  if (extra > 0) shown.push(`and ${String(extra)} more`);

  return {
    title,
    url: str(b.compare_url) ?? str(b.compare) ?? str(head.url),
    description: shown.join('\n') || undefined,
    color: deleted ? COLORS.red : COLORS.blue,
  };
}

function pullRequest(b: Obj, repo: string): LooseEmbed | null {
  const action = str(b.action) ?? 'updated';
  if (QUIET_ACTIONS.has(action)) return null;
  const pr = obj(b.pull_request);
  const merged = pr.merged === true;
  const verb =
    action === 'closed' && merged
      ? 'merged'
      : action === 'synchronize' || action === 'synchronized'
        ? 'updated'
        : label(action);
  const head = str(obj(pr.head).ref);
  const base = str(obj(pr.base).ref);
  return {
    title: `[${repo}] Pull request ${verb}: #${str(b.number) ?? str(pr.number) ?? '?'} ${str(pr.title) ?? ''}`,
    url: str(pr.html_url),
    description: action === 'opened' ? brief(str(pr.body)) : undefined,
    color: merged
      ? COLORS.purple
      : action === 'closed'
        ? COLORS.red
        : action === 'opened'
          ? COLORS.green
          : COLORS.blue,
    fields:
      head && base ? [{ name: 'Branch', value: `${head} -> ${base}`, inline: true }] : undefined,
  };
}

function issue(b: Obj, repo: string): LooseEmbed | null {
  const action = str(b.action) ?? 'updated';
  if (QUIET_ACTIONS.has(action)) return null;
  const item = obj(b.issue);
  return {
    title: `[${repo}] Issue ${label(action)}: #${str(item.number) ?? '?'} ${str(item.title) ?? ''}`,
    url: str(item.html_url),
    description: action === 'opened' ? brief(str(item.body)) : undefined,
    color:
      action === 'opened' || action === 'reopened'
        ? COLORS.green
        : action === 'closed'
          ? COLORS.red
          : COLORS.blue,
  };
}

function comment(b: Obj, repo: string): LooseEmbed | null {
  if ((str(b.action) ?? 'created') !== 'created') return null;
  const item = obj(b.issue ?? b.pull_request);
  const note = obj(b.comment);
  return {
    title: `[${repo}] New comment on #${str(item.number) ?? '?'} ${str(item.title) ?? ''}`,
    url: str(note.html_url) ?? str(item.html_url),
    description: brief(str(note.body)),
    color: COLORS.blue,
  };
}

function review(b: Obj, repo: string, event: string): LooseEmbed | null {
  const pr = obj(b.pull_request);
  const note = obj(b.review);
  // GitHub: action "submitted" with review.state; Gitea: the event name says the outcome.
  const state = (str(note.state) ?? str(note.type) ?? event.replace('pull_request_review_', ''))
    .toLowerCase()
    .replace('pull_request_review', 'reviewed');
  if ((str(b.action) ?? 'submitted') === 'dismissed') return null;
  const color = state.includes('approv')
    ? COLORS.green
    : state.includes('change') || state.includes('reject')
      ? COLORS.red
      : COLORS.blue;
  return {
    title: `[${repo}] Review on #${str(pr.number) ?? str(b.number) ?? '?'}: ${label(state)}`,
    url: str(note.html_url) ?? str(pr.html_url),
    description: brief(str(note.body) ?? str(note.content)),
    color,
  };
}

function release(b: Obj, repo: string): LooseEmbed | null {
  const action = str(b.action) ?? 'published';
  // GitHub also sends created, edited and released for the same release; one message is enough.
  if (action !== 'published' && action !== 'prereleased') return null;
  const item = obj(b.release);
  const name = str(item.name) ?? str(item.tag_name) ?? 'release';
  return {
    title: `[${repo}] ${item.prerelease === true ? 'Pre-release' : 'Release'} published: ${name}`,
    url: str(item.html_url),
    description: brief(str(item.body), 400),
    color: COLORS.teal,
  };
}

function workflowRun(b: Obj, repo: string): LooseEmbed | null {
  const run = obj(b.workflow_run);
  if ((str(b.action) ?? 'completed') !== 'completed') return null;
  const conclusion = str(run.conclusion) ?? str(run.status) ?? 'finished';
  const color =
    conclusion === 'success'
      ? COLORS.green
      : conclusion === 'failure' || conclusion === 'timed_out'
        ? COLORS.red
        : conclusion === 'cancelled' || conclusion === 'skipped'
          ? COLORS.grey
          : COLORS.yellow;
  const branch = str(run.head_branch);
  return {
    title: `[${repo}] Workflow ${str(run.name) ?? 'run'}: ${label(conclusion)}`,
    url: str(run.html_url),
    description: brief(str(run.display_title) ?? str(obj(run.head_commit).message)),
    color,
    fields: branch ? [{ name: 'Branch', value: branch, inline: true }] : undefined,
  };
}

/** Forgejo Actions: events `action_run_failure`, `action_run_recover` and `action_run_success`. */
function actionRun(b: Obj, repo: string, event: string): LooseEmbed {
  const run = obj(b.run);
  const outcome = event.replace('action_run_', '') || (str(b.action) ?? 'finished');
  const color =
    outcome === 'failure'
      ? COLORS.red
      : outcome === 'success' || outcome === 'recover'
        ? COLORS.green
        : COLORS.yellow;
  const where = str(run.prettyref) ?? str(run.ref);
  return {
    title:
      `[${repo}] Action run ${outcome === 'recover' ? 'recovered' : outcome}: ${str(run.title) ?? str(run.workflow_id) ?? ''}`.trim(),
    url: str(run.html_url),
    color,
    fields: where ? [{ name: 'Ref', value: where, inline: true }] : undefined,
  };
}

function refEvent(b: Obj, repo: string, event: string): LooseEmbed {
  const kind = str(b.ref_type) ?? 'ref';
  return {
    title: `[${repo}] ${kind} ${ref(str(b.ref)).name} ${event === 'delete' ? 'deleted' : 'created'}`,
    color: event === 'delete' ? COLORS.red : COLORS.green,
  };
}

function make(flavor: 'github' | 'forgejo'): Preset {
  return (headers, body): LooseMessage | null => {
    const b = obj(body);
    const event = eventOf(flavor, headers, b);
    if (event === undefined) return null;
    const repoInfo = obj(b.repository);
    const repo = str(repoInfo.full_name) ?? str(repoInfo.name) ?? 'repository';
    const sender = obj(b.sender);
    const who =
      str(sender.login) ??
      str(sender.username) ??
      str(obj(b.pusher).login) ??
      str(obj(b.pusher).name);

    if (NOISY_EVENTS.has(event)) return null;
    if (event === 'ping') {
      return {
        embeds: [
          {
            title: `[${repo}] Webhook connected`,
            description: brief(str(b.zen)),
            color: COLORS.green,
          },
        ],
      };
    }

    let embed: LooseEmbed | null;
    if (event === 'push') embed = push(b, repo);
    else if (event === 'pull_request') embed = pullRequest(b, repo);
    else if (event === 'issues') embed = issue(b, repo);
    else if (event === 'issue_comment' || event === 'pull_request_comment')
      embed = comment(b, repo);
    else if (event.startsWith('pull_request_review')) embed = review(b, repo, event);
    else if (event === 'release') embed = release(b, repo);
    else if (event === 'workflow_run') embed = workflowRun(b, repo);
    else if (event.startsWith('action_run')) embed = actionRun(b, repo, event);
    else if (event === 'create' || event === 'delete') embed = refEvent(b, repo, event);
    else {
      // Unknown to this preset: one plain line is better than silence or a wall of JSON.
      const action = str(b.action);
      return {
        content: `[${repo}] ${label(event)}${action ? ` (${label(action)})` : ''}${who ? ` by ${who}` : ''}`,
      };
    }
    if (!embed) return null;
    return {
      embeds: [{ ...embed, author: who, footer: repo }],
    };
  };
}

export const github: Preset = make('github');
export const forgejo: Preset = make('forgejo');
