/** True when a GIF, WebP or PNG file holds more than one frame. Reads headers only; never decodes pixels. */
export function isAnimatedImage(bytes: Buffer, contentType: string): boolean {
  switch (contentType) {
    case 'image/gif':
      return gifFrames(bytes) > 1;
    case 'image/webp':
      return isAnimatedWebp(bytes);
    case 'image/png':
      return isAnimatedPng(bytes);
    default:
      return false;
  }
}

function isAnimatedWebp(bytes: Buffer): boolean {
  if (bytes.length < 21 || bytes.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (bytes.toString('ascii', 8, 12) !== 'WEBP') return false;
  // The extended header's flags byte: bit 1 marks an animation.
  return bytes.toString('ascii', 12, 16) === 'VP8X' && ((bytes[20] ?? 0) & 0x02) !== 0;
}

function isAnimatedPng(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    offset += 12 + length;
  }
  return false;
}

/** Counts image descriptors by walking the GIF block structure. */
function gifFrames(bytes: Buffer): number {
  if (bytes.length < 13) return 0;
  let offset = 13;
  const flags = bytes[10] ?? 0;
  if (flags & 0x80) offset += 3 * 2 ** ((flags & 0x07) + 1);
  let frames = 0;
  while (offset < bytes.length) {
    const block = bytes[offset];
    if (block === 0x3b) break;
    if (block === 0x2c) {
      frames += 1;
      if (frames > 1) return frames;
      const local = bytes[offset + 9] ?? 0;
      offset += 10;
      if (local & 0x80) offset += 3 * 2 ** ((local & 0x07) + 1);
      offset += 1;
      offset = skipSubBlocks(bytes, offset);
    } else if (block === 0x21) {
      offset = skipSubBlocks(bytes, offset + 2);
    } else {
      break;
    }
  }
  return frames;
}

function skipSubBlocks(bytes: Buffer, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset] ?? 0;
    offset += 1 + size;
    if (size === 0) break;
  }
  return offset;
}
