/**
 * A small Markdown subset parsed into a plain tree. Rendering to React lives in
 * `Markdown.tsx`; nothing here produces HTML strings.
 */

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'bold' | 'italic' | 'strike'; children: Inline[] }
  | { type: 'link'; href: string; label: string }
  | { type: 'mention'; userId: string }
  | { type: 'break' };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; language: string; value: string };

const MAX_DEPTH = 6;
const ESCAPABLE = '\\`*_~<>[]()#+-.!|:/@';
const URL_START = /^https?:\/\/[^\s<>]+/i;
const MENTION = /^<@(\d{1,18})>/;
const FENCE = /^```([\w+-]*)[ \t]*\n([\s\S]*?)\n?```[ \t]*(?:\n|$)/;

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let rest = source.replace(/\r\n?/g, '\n');
  let buffer: string[] = [];
  let quote: string[] = [];

  const flushText = () => {
    if (buffer.length) {
      blocks.push({ type: 'paragraph', children: parseInline(buffer.join('\n')) });
      buffer = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ type: 'quote', children: parseInline(quote.join('\n')) });
      quote = [];
    }
  };

  while (rest.length > 0) {
    const fence = FENCE.exec(rest);
    if (fence) {
      flushText();
      flushQuote();
      blocks.push({ type: 'code', language: fence[1] ?? '', value: fence[2] ?? '' });
      rest = rest.slice(fence[0].length);
      continue;
    }
    const newline = rest.indexOf('\n');
    const line = newline === -1 ? rest : rest.slice(0, newline);
    rest = newline === -1 ? '' : rest.slice(newline + 1);

    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushText();
      quote.push(quoted[1] ?? '');
    } else {
      flushQuote();
      buffer.push(line);
    }
  }
  flushText();
  flushQuote();
  return blocks.filter((block) => block.type !== 'paragraph' || block.children.length > 0);
}

/** Index of the closing `delimiter`, skipping code spans and escapes; -1 when there is none. */
function findClose(source: string, delimiter: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') {
      i++;
    } else if (char === '`') {
      const run = /^`+/.exec(source.slice(i))?.[0] ?? '`';
      const end = source.indexOf(run, i + run.length);
      i = end === -1 ? i + run.length - 1 : end + run.length - 1;
    } else if (source.startsWith(delimiter, i)) {
      const next = source[i + delimiter.length];
      if (next === delimiter[0]) {
        // Inside a longer run: a one-char closer must skip it whole, a two-char closer
        // closes on the run's last two characters.
        if (delimiter.length === 1) i += 1;
        continue;
      }
      return i;
    }
  }
  return -1;
}

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isWord = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    const unbalanced =
      last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0);
    if (/[.,;:!?'"*_~\]}>]/.test(last) || unbalanced) url = url.slice(0, -1);
    else return url;
  }
}

export function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const pushText = () => {
    if (text) out.push({ type: 'text', value: text });
    text = '';
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const char = source[i] ?? '';

    if (char === '\n') {
      pushText();
      out.push({ type: 'break' });
      i++;
      continue;
    }
    if (char === '\\' && rest.length > 1 && ESCAPABLE.includes(rest[1] ?? '')) {
      text += rest[1];
      i += 2;
      continue;
    }
    if (char === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`';
      const end = source.indexOf(run, i + run.length);
      if (end > i + run.length) {
        pushText();
        out.push({ type: 'code', value: source.slice(i + run.length, end).trim() });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    const mention = MENTION.exec(rest);
    if (mention?.[1]) {
      pushText();
      out.push({ type: 'mention', userId: mention[1] });
      i += mention[0].length;
      continue;
    }
    if ((char === 'h' || char === 'H') && !isWord(source[i - 1])) {
      const match = URL_START.exec(rest);
      const label = match ? trimUrl(match[0]) : '';
      const href = label ? safeHref(label) : null;
      if (href) {
        pushText();
        out.push({ type: 'link', href, label });
        i += label.length;
        continue;
      }
    }

    const wrapped = depth < MAX_DEPTH ? parseWrapped(source, i, depth) : null;
    if (wrapped) {
      pushText();
      out.push(wrapped.node);
      i = wrapped.end;
      continue;
    }
    text += char;
    i++;
  }
  pushText();
  return out;
}

const MARKERS: readonly (readonly [string, 'bold' | 'italic' | 'strike'])[] = [
  ['***', 'bold'],
  ['**', 'bold'],
  ['~~', 'strike'],
  ['*', 'italic'],
  ['_', 'italic'],
];

function parseWrapped(
  source: string,
  start: number,
  depth: number,
): { node: Inline; end: number } | null {
  for (const [marker, type] of MARKERS) {
    if (!source.startsWith(marker, start)) continue;
    const contentStart = start + marker.length;
    const first = source[contentStart];
    // The opener must hug the text, and a lone `*` never starts on a `**` run.
    if (isSpace(first) || (marker.length === 1 && first === marker)) continue;
    if (marker === '_' && isWord(source[start - 1])) continue;

    const close = findClose(source, marker, contentStart);
    if (close <= contentStart || isSpace(source[close - 1])) continue;
    if (marker === '_' && isWord(source[close + 1])) continue;

    const children = parseInline(source.slice(contentStart, close), depth + 1);
    const node: Inline =
      marker === '***'
        ? { type: 'bold', children: [{ type: 'italic', children }] }
        : { type, children };
    return { node, end: close + marker.length };
  }
  return null;
}
