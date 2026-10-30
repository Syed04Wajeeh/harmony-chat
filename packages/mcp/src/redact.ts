import path from 'node:path';

/**
 * What the control room may show about a tool call. Everything here ends up in a channel that
 * other people read, so the rule is: show where the agent is working, never what it is holding.
 * File contents, edit bodies, environment values, headers and anything token-shaped stay out.
 */

const MASK = '[redacted]';

const KEY_NAME = String.raw`[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key|session[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*`;

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Harmony bot tokens, GitHub, Slack, OpenAI/Anthropic-style, AWS, npm, Google keys.
  [/\bhb_\d+_[A-Za-z0-9_-]+/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  // Credentials inside a URL: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // HTTP headers and bearer tokens.
  [/\b(authorization|x-api-key|x-auth-token|cookie|set-cookie)\s*[:=]\s*[^\n"']+/gi, `$1: ${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // --password hunter2, --token=abc, -p secret is not guessed (too many false hits).
  [
    /(--?(?:[a-z-]*(?:token|secret|passw(?:or)?d|api-?key|auth|credential)[a-z-]*))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    `$1=${MASK}`,
  ],
  // NAME=value where the name says it is a secret (env assignments, exports, .env lines).
  [new RegExp(String.raw`\b(${KEY_NAME})\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)`, 'gi'), `$1=${MASK}`],
];

/** Long unbroken strings that mix letters and digits look like keys, whatever they are called. */
const HIGH_ENTROPY = /[A-Za-z0-9_+/=-]{32,}/g;

function entropyMask(text: string): string {
  return text.replace(HIGH_ENTROPY, (match) => {
    const hasDigit = /\d/.test(match);
    const hasLetter = /[A-Za-z]/.test(match);
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(match)).length;
    // Paths and long words are not secrets; a mixed-case-and-digit blob is.
    if (match.includes('/') && !/[A-Z]/.test(match)) return match;
    return hasDigit && hasLetter && classes >= 2 ? MASK : match;
  });
}

/** Removes secret-looking text. `changed` says whether anything was removed. */
export function redact(text: string): { text: string; changed: boolean } {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = entropyMask(out);
  return { text: out, changed: out !== text };
}

export const redactText = (text: string): string => redact(text).text;

/** Commands whose whole point is to print or read secrets: never echoed, not even redacted. */
const SECRET_READERS = [
  /^\s*(?:env|printenv|export|set|declare\s+-x|typeset\s+-x)\s*(?:$|[|;&>])/,
  /\b(?:cat|less|more|head|tail|bat|grep|rg|source|\.)\s+[^|;&]*(?:\.env\b|\.netrc|id_(?:rsa|ed25519|ecdsa)|\.pem\b|\.key\b|credentials|secrets?\.|\.npmrc|\.pgpass|\.aws\/|\.ssh\/|\.git-credentials)/,
  /\bdocker\s+inspect\b|\bkubectl\s+get\s+secret/,
  /\becho\s+["']?\$\{?[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSW)/i,
];

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/** A Bash command for display: one line, redacted, and withheld when it reads secrets. */
export function describeCommand(command: string, max = 90): string {
  const flat = oneLine(command);
  if (SECRET_READERS.some((re) => re.test(flat))) return '[command withheld: may expose secrets]';
  const { text, changed } = redact(flat);
  if (changed) {
    // A command that carried a secret is shown by its first word only.
    const first = flat.split(' ')[0] ?? '';
    return `${clip(redactText(first), 30)} … [arguments withheld: contained a secret]`;
  }
  return clip(text, max);
}

/** A path relative to the working folder when it is inside it, else its last two segments. */
export function shortPath(file: string, cwd: string | undefined): string {
  const clean = redactText(file);
  if (cwd && path.isAbsolute(clean)) {
    const rel = path.relative(cwd, clean);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return clip(rel, 80);
  }
  const parts = clean.split(path.sep).filter(Boolean);
  return clip(parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : clean, 80);
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** "Edit apps/server/src/x.ts", "Bash: pnpm test:unit": what a tool call is doing, safe to show. */
export function describeActivity(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  cwd: string | undefined,
): string {
  const tool = toolName ?? 'tool';
  const args = input ?? {};
  const file = str(args.file_path) ?? str(args.notebook_path) ?? str(args.path);
  switch (tool) {
    case 'Bash': {
      const command = str(args.command);
      return command ? `Bash: ${describeCommand(command)}` : 'Bash';
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'Read':
      return file ? `${tool} ${shortPath(file, cwd)}` : tool;
    case 'Glob':
    case 'Grep': {
      const pattern = str(args.pattern);
      return pattern ? `${tool} ${clip(oneLine(redactText(pattern)), 50)}` : tool;
    }
    case 'WebFetch': {
      const url = str(args.url);
      try {
        return url ? `WebFetch ${new URL(url).host}` : tool;
      } catch {
        return tool;
      }
    }
    case 'WebSearch': {
      const query = str(args.query);
      return query ? `WebSearch ${clip(oneLine(redactText(query)), 60)}` : tool;
    }
    case 'Agent':
    case 'Task': {
      const description = str(args.description);
      return description
        ? `Starting subagent: ${clip(oneLine(redactText(description)), 70)}`
        : 'Starting a subagent';
    }
    default:
      // MCP and other tools: the name only, their input could be anything.
      return clip(tool, 60);
  }
}
