import type { Readable } from 'node:stream';

/** Reads a stream into memory, giving up past `max` bytes (null). */
export async function readUpTo(stream: Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > max) {
      stream.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
