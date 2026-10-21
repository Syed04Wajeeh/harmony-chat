import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../../src/uploads/filename.js';

describe('sanitizeFilename', () => {
  it.each([
    ['photo.png', 'photo.png'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\report.pdf', 'report.pdf'],
    ['a/b\\c.txt', 'c.txt'],
    ['<script>alert(1)</script>.html', 'script_.html'],
    ['name with  spaces .txt', 'name with spaces .txt'],
    ['.hidden', 'hidden'],
    ['...', 'file'],
    ['', 'file'],
    ['   ', 'file'],
    ['trailing. ', 'trailing'],
    ['tab\there\u0000.txt', 'tabhere.txt'],
    ['evil\u202egpj.exe', 'evilgpj.exe'],
    ['quote"pipe|star*.txt', 'quote_pipe_star_.txt'],
    ['100%.txt', '100_.txt'],
    ['résumé.pdf', 'résumé.pdf'],
    ['日本語.txt', '日本語.txt'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('normalizes to NFC', () => {
    expect(sanitizeFilename('e\u0301.txt')).toBe('\u00e9.txt');
  });

  it('truncates long names but keeps the extension', () => {
    const result = sanitizeFilename(`${'a'.repeat(300)}.jpeg`);
    expect(result).toHaveLength(100);
    expect(result.endsWith('.jpeg')).toBe(true);
  });

  it('truncates long names without an extension', () => {
    expect(sanitizeFilename('b'.repeat(500))).toHaveLength(100);
  });
});
