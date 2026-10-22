/**
 * Sanitizer for user-supplied CSS. The server stores the sanitized text and the client sanitizes
 * again before injecting it, with this same function (docs/security/trust-model.md, "Custom CSS").
 *
 * CSS cannot run script, but a `url()` fires a request, and with attribute selectors that request
 * can leak what is on screen. So everything that can load a resource is removed: `@import`,
 * `url()` (except small inline raster images), image functions that take bare strings, and
 * `@font-face` blocks that load a remote source. Escapes outside strings are decoded and comments
 * dropped before matching, so `u\rl(`, `\75 rl(` and `url/**\/(`-style tricks see the same text the
 * browser would. Removal repeats until the text stops changing, so a removal cannot assemble a new
 * `url(`.
 */

export const MAX_CUSTOM_CSS_BYTES = 20 * 1024;

export interface SanitizedCss {
  css: string;
  /** What was removed, for the settings page to report. */
  removed: string[];
}

const DATA_IMAGE = /^data:image\/(?:png|gif|webp|jpeg);base64,[a-z0-9+/=]+$/i;
const IMAGE_FUNCTIONS = [
  'image-set',
  '-webkit-image-set',
  'cross-fade',
  '-webkit-cross-fade',
  'image',
  'src',
];
const MAX_PASSES = 8;

const isHex = (char: string) => /[0-9a-f]/i.test(char);

/**
 * Drops comments (as a space, so `u/**\/rl` stays two tokens) and decodes escapes outside strings.
 * Strings are copied verbatim.
 */
function normalize(input: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i] ?? '';
    if (quote) {
      out += char;
      if (char === '\\') out += input[++i] ?? '';
      else if (char === quote || char === '\n') quote = '';
      continue;
    }
    if (char === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      out += ' ';
      if (end === -1) break;
      i = end + 1;
    } else if (char === '"' || char === "'") {
      quote = char;
      out += char;
    } else if (char === '\\') {
      let digits = '';
      while (digits.length < 6 && isHex(input[i + 1] ?? '')) digits += input[++i];
      if (digits) {
        if (/\s/.test(input[i + 1] ?? '')) i++;
        const code = Number.parseInt(digits, 16);
        out +=
          code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
            ? '�'
            : String.fromCodePoint(code);
      } else if (input[i + 1] === '\n') {
        i++;
      } else {
        out += input[i + 1] ?? '�';
        i++;
      }
    } else {
      out += char;
    }
  }
  return out;
}

/** Index just past the `)` that closes the `(` at `open`, or -1. Strings are skipped. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const char = text[i] ?? '';
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Index just past the end of the statement or block starting at `from`. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (char === '{') depth++;
    else if (char === '}') {
      if (--depth <= 0) return i + 1;
    } else if (char === ';' && depth === 0) return i + 1;
  }
  return text.length;
}

function urlArgument(text: string, open: number, close: number): string {
  const inner = text.slice(open + 1, close - 1).trim();
  const quote = inner[0];
  if ((quote === '"' || quote === "'") && inner.endsWith(quote) && inner.length >= 2) {
    return normalize(inner.slice(1, -1).replace(/\\\n/g, ''));
  }
  return inner;
}

/** Replaces every `name(...)` call with `none`; `boundary` ignores names that end a longer identifier. */
function replaceCalls(
  css: string,
  name: string,
  boundary: boolean,
  keep: (argument: string) => boolean = () => false,
): { css: string; found: boolean } {
  const pattern = new RegExp(
    `${boundary ? '(?<![\\w-])' : ''}${name.replaceAll('-', '\\-')}\\s*\\(`,
    'gi',
  );
  let found = false;
  let from = 0;
  for (;;) {
    pattern.lastIndex = from;
    const match = pattern.exec(css);
    if (!match) return { css, found };
    const open = match.index + match[0].length - 1;
    const close = closingParen(css, open);
    if (close !== -1 && keep(urlArgument(css, open, close))) {
      from = close;
      continue;
    }
    found = true;
    css = css.slice(0, match.index) + 'none' + (close === -1 ? '' : css.slice(close));
    from = match.index + 4;
  }
}

const isDataImage = (argument: string) => DATA_IMAGE.test(argument);

/** Whether an `@font-face` body loads anything but inline data; `local()` sources are fine. */
const loadsRemoteFont = (block: string) =>
  [...block.matchAll(/url\s*\(([^)]*)\)/gi)].some(
    (m) => !isDataImage((m[1] ?? '').trim().replace(/^["']|["']$/g, '')),
  );

function pass(text: string, removed: Set<string>): string {
  let css = text.replace(/<\/?\s*(?:style|script)/gi, () => {
    removed.add('html');
    return '';
  });

  for (let at = css.search(/@import\b/i); at !== -1; at = css.search(/@import\b/i)) {
    removed.add('@import');
    css = css.slice(0, at) + css.slice(statementEnd(css, at));
  }

  const fontFace = /@font-face\s*\{/gi;
  for (let match = fontFace.exec(css); match; match = fontFace.exec(css)) {
    const end = statementEnd(css, match.index);
    if (!loadsRemoteFont(css.slice(match.index, end))) continue;
    removed.add('@font-face');
    css = css.slice(0, match.index) + css.slice(end);
    fontFace.lastIndex = match.index;
  }

  for (const name of ['expression', ...IMAGE_FUNCTIONS]) {
    const result = replaceCalls(css, name, true);
    if (result.found) removed.add(`${name}()`);
    css = result.css;
  }
  const urls = replaceCalls(css, 'url', false, isDataImage);
  if (urls.found) removed.add('url()');
  css = urls.css;

  css = css.replace(/(?:java|vb)script\s*:/gi, () => {
    removed.add('javascript:');
    return '';
  });
  css = css.replace(/(?:-moz-binding|behavior)\s*:[^;}]*;?/gi, () => {
    removed.add('binding');
    return '';
  });
  return css;
}

export function sanitizeCss(input: string): SanitizedCss {
  const removed = new Set<string>();
  let css = normalize(input.replaceAll('\u0000', ''));
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = pass(css, removed);
    if (next === css) return { css: css.trim(), removed: [...removed] };
    css = next;
  }
  // Still changing after the pass limit: refuse rather than guess.
  return { css: '', removed: [...removed, 'unstable'] };
}

export const cssByteLength = (css: string): number => new TextEncoder().encode(css).length;
