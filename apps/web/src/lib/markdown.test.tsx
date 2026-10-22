import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../components/Markdown.js';
import { parseInline, parseMarkdown, safeHref } from './markdown.js';

const html = (content: string) =>
  renderToStaticMarkup(
    <Markdown content={content} meId="1" nameOf={(id) => ({ '1': 'Ada', '2': 'Linus' })[id]} />,
  );

describe('parseInline', () => {
  it('parses bold, italic, strikethrough and code', () => {
    expect(parseInline('**b** *i* _j_ ~~s~~ `c`')).toEqual([
      { type: 'bold', children: [{ type: 'text', value: 'b' }] },
      { type: 'text', value: ' ' },
      { type: 'italic', children: [{ type: 'text', value: 'i' }] },
      { type: 'text', value: ' ' },
      { type: 'italic', children: [{ type: 'text', value: 'j' }] },
      { type: 'text', value: ' ' },
      { type: 'strike', children: [{ type: 'text', value: 's' }] },
      { type: 'text', value: ' ' },
      { type: 'code', value: 'c' },
    ]);
  });

  it('nests markers', () => {
    expect(parseInline('**bold *and italic***')).toEqual([
      {
        type: 'bold',
        children: [
          { type: 'text', value: 'bold ' },
          { type: 'italic', children: [{ type: 'text', value: 'and italic' }] },
        ],
      },
    ]);
    expect(parseInline('***both***')).toEqual([
      { type: 'bold', children: [{ type: 'italic', children: [{ type: 'text', value: 'both' }] }] },
    ]);
  });

  it('leaves unmatched and spaced markers as text', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', value: '2 * 3 * 4' }]);
    expect(parseInline('**unclosed')).toEqual([{ type: 'text', value: '**unclosed' }]);
    expect(parseInline('snake_case_name')).toEqual([{ type: 'text', value: 'snake_case_name' }]);
  });

  it('does not parse markers inside code', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ type: 'code', value: '**not bold**' }]);
  });

  it('supports backslash escapes', () => {
    expect(parseInline('\\*literal\\*')).toEqual([{ type: 'text', value: '*literal*' }]);
  });

  it('parses mentions', () => {
    expect(parseInline('hi <@42>!')).toEqual([
      { type: 'text', value: 'hi ' },
      { type: 'mention', userId: '42' },
      { type: 'text', value: '!' },
    ]);
  });

  it('autolinks http(s) URLs and trims trailing punctuation', () => {
    expect(parseInline('see https://example.com/a?b=1, ok')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', href: 'https://example.com/a?b=1', label: 'https://example.com/a?b=1' },
      { type: 'text', value: ', ok' },
    ]);
    const wiki = parseInline('(https://example.com/a_(b))');
    expect(wiki).toContainEqual(
      expect.objectContaining({ type: 'link', label: 'https://example.com/a_(b)' }),
    );
  });

  it('bounds nesting depth instead of recursing forever', () => {
    const deep = '*'.repeat(1) + 'a'.repeat(5) + '*';
    expect(() => parseInline(`${'**_'.repeat(200)}x${'_**'.repeat(200)}`)).not.toThrow();
    expect(parseInline(deep)).toHaveLength(1);
  });
});

describe('parseMarkdown', () => {
  it('parses fenced code blocks with a language', () => {
    expect(parseMarkdown('before\n```ts\nconst a = 1;\n```\nafter')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'before' }] },
      { type: 'code', language: 'ts', value: 'const a = 1;' },
      { type: 'paragraph', children: [{ type: 'text', value: 'after' }] },
    ]);
  });

  it('keeps markdown literal inside fences', () => {
    const [block] = parseMarkdown('```\n**x** <b>y</b>\n```');
    expect(block).toEqual({ type: 'code', language: '', value: '**x** <b>y</b>' });
  });

  it('groups consecutive quote lines', () => {
    const blocks = parseMarkdown('> one\n> two\nthree');
    expect(blocks.map((b) => b.type)).toEqual(['quote', 'paragraph']);
  });

  it('treats an unterminated fence as text', () => {
    expect(parseMarkdown('```\nopen')[0]?.type).toBe('paragraph');
  });
});

describe('safeHref', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<b>',
    'vbscript:x',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s', (value) => expect(safeHref(value)).toBeNull());
  it('accepts http and https', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com/');
    expect(safeHref('http://example.com/x')).toBe('http://example.com/x');
  });
});

describe('rendering', () => {
  it('renders formatting as elements', () => {
    expect(html('**b** *i* ~~s~~ `c`')).toBe(
      '<p class="md-paragraph"><strong>b</strong> <em>i</em> <del>s</del> <code class="md-code">c</code></p>',
    );
  });

  it('adds rel and target to links', () => {
    expect(html('https://example.com')).toContain(
      '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">',
    );
  });

  it('highlights mentions of me and shows names', () => {
    const out = html('<@1> and <@2> and <@9>');
    expect(out).toContain('class="mention mention-me">@Ada');
    expect(out).toContain('class="mention">@Linus');
    expect(out).toContain('@unknown');
  });

  describe('XSS attempts', () => {
    it('escapes HTML tags', () => {
      const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)>');
      expect(out).not.toContain('<script');
      expect(out).not.toContain('<img');
      expect(out).toContain('&lt;script&gt;');
    });

    it('never produces a javascript: link, including markdown-style links', () => {
      for (const input of [
        '[click](javascript:alert(1))',
        'javascript:alert(1)',
        'JaVaScRiPt:alert(1)',
        '<a href="javascript:alert(1)">x</a>',
        'https://example.com" onmouseover="alert(1)',
        '<https://example.com>',
      ]) {
        const out = html(input);
        expect(out).not.toMatch(/href="javascript/i);
        expect(out).not.toMatch(/<a [^>]*onmouseover/i);
        expect(out).not.toContain('<a href="&quot;');
      }
    });

    it('keeps quotes in URLs from breaking out of the attribute', () => {
      const out = html('https://example.com/"><script>alert(1)</script>');
      expect(out).not.toContain('<script');
      expect(out.match(/<a /g)?.length ?? 0).toBeLessThanOrEqual(1);
    });

    it('does not interpret HTML inside nested markers or code', () => {
      const out = html('**<b onclick=x>bold</b>** `<i>` ```<u>```');
      expect(out).not.toMatch(/<(b|i|u) /);
      expect(out).not.toContain('<i>');
      expect(out).not.toContain('<u>');
    });

    it('escapes content in code blocks', () => {
      expect(html('```\n<img src=x onerror=1>\n```')).toContain('&lt;img src=x onerror=1&gt;');
    });

    it('renders hostile display names as text', () => {
      const out = renderToStaticMarkup(
        <Markdown content="<@3>" meId="1" nameOf={() => '<img src=x onerror=alert(1)>'} />,
      );
      expect(out).not.toContain('<img');
    });
  });
});
