import { crc32, deflateSync } from 'node:zlib';

type Pixel = readonly [number, number, number];

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** A tiny PNG encoder so tests can upload real images without binary fixtures. */
export function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Pixel,
): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      rows[offset + 1 + x * 3] = r;
      rows[offset + 2 + x * 3] = g;
      rows[offset + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/** A soft sunset-style gradient with a sun and hills; stands in for a photo. */
export function scenePng(width: number, height: number): Buffer {
  return makePng(width, height, (x, y) => {
    const t = y / height;
    const sky: Pixel = [mix(250, 70, t), mix(170, 90, t), mix(120, 190, t)];
    const dx = x - width * 0.68;
    const dy = y - height * 0.38;
    if (dx * dx + dy * dy < (height * 0.13) ** 2) return [255, 236, 190];
    const ridge =
      height * (0.72 + 0.06 * Math.sin(x / (width / 9)) + 0.04 * Math.sin(x / (width / 23)));
    if (y > ridge)
      return [
        mix(30, 14, (y - ridge) / height),
        mix(46, 24, (y - ridge) / height),
        mix(70, 40, (y - ridge) / height),
      ];
    return sky;
  });
}
