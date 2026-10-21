const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
// Whitespace between two adjacent encoded words is not part of the text (RFC 2047 section 6.2).
const WORD_GAP = /(\?=)\s+(?==\?)/g;

function decodeQ(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const hex = text.slice(i + 1, i + 3);
    if (char === '_') {
      bytes.push(0x20);
    } else if (char === '=' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function decodeWord(charset: string, encoding: string, text: string): string | null {
  try {
    const bytes =
      encoding.toLowerCase() === 'b' ? Uint8Array.from(Buffer.from(text, 'base64')) : decodeQ(text);
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decodes RFC 2047 encoded-words (`=?utf-8?q?...?=`, `b` or `q`); other text passes through. */
export function decodeMimeWords(input: string): string {
  return input
    .replace(WORD_GAP, '$1')
    .replace(
      ENCODED_WORD,
      (word, charset: string, encoding: string, text: string) =>
        decodeWord(charset, encoding, text) ?? word,
    );
}
