import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export interface Storage {
  put(key: string, stream: Readable): Promise<void>;
  /** Rejects with ENOENT when the key does not exist. */
  get(key: string): Promise<Readable>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9-]{1,64}$/;

/** Stores each object as one file under `root`; keys are restricted so they cannot escape it. */
export class LocalDiskStorage implements Storage {
  constructor(private readonly root: string) {}

  async put(key: string, stream: Readable): Promise<void> {
    const target = this.pathFor(key);
    const partial = `${target}.partial`;
    await mkdir(this.root, { recursive: true });
    try {
      await pipeline(stream, createWriteStream(partial, { flags: 'wx', mode: 0o640 }));
      await rename(partial, target);
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Readable> {
    const target = this.pathFor(key);
    await stat(target);
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private pathFor(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error('Invalid storage key');
    return path.join(this.root, key);
  }
}
