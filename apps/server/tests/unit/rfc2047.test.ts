import { describe, expect, it } from 'vitest';
import { decodeMimeWords } from '../../src/auth/rfc2047.js';

describe('decodeMimeWords', () => {
  it('passes plain text through', () => {
    expect(decodeMimeWords('Ada Lovelace')).toBe('Ada Lovelace');
    expect(decodeMimeWords('')).toBe('');
  });

  it('decodes Q-encoded UTF-8', () => {
    expect(decodeMimeWords('=?utf-8?q?Jos=C3=A9_Garc=C3=ADa?=')).toBe('José García');
  });

  it('decodes B-encoded UTF-8', () => {
    expect(decodeMimeWords('=?UTF-8?B?5L2g5aW9?=')).toBe('你好');
  });

  it('is case-insensitive about the encoding marker and charset', () => {
    expect(decodeMimeWords('=?UTF-8?Q?caf=c3=a9?=')).toBe('café');
  });

  it('joins adjacent encoded words without the whitespace between them', () => {
    expect(decodeMimeWords('=?utf-8?q?Jos=C3=A9?= =?utf-8?q?_Garc=C3=ADa?=')).toBe('José García');
  });

  it('keeps plain text around an encoded word', () => {
    expect(decodeMimeWords('Dr. =?utf-8?q?Zo=C3=AB?= Smith')).toBe('Dr. Zoë Smith');
  });

  it('decodes other charsets', () => {
    expect(decodeMimeWords('=?iso-8859-1?q?caf=E9?=')).toBe('café');
  });

  it('leaves invalid UTF-8 or unknown charsets undecoded', () => {
    expect(decodeMimeWords('=?utf-8?q?=FF=FE?=')).toBe('=?utf-8?q?=FF=FE?=');
    expect(decodeMimeWords('=?x-nope?q?abc?=')).toBe('=?x-nope?q?abc?=');
  });

  it('leaves malformed encoded-words alone', () => {
    expect(decodeMimeWords('=?utf-8?x?abc?=')).toBe('=?utf-8?x?abc?=');
  });
});
