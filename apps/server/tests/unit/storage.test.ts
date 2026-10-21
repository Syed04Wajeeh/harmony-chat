import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage } from '../../src/uploads/storage.js';

describe('LocalDiskStorage', () => {
  let root: string;
  let storage: LocalDiskStorage;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harmony-storage-'));
    storage = new LocalDiskStorage(path.join(root, 'nested'));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('round-trips bytes and creates the root on first write', async () => {
    await storage.put('abc-123', Readable.from(['hello ', 'world']));
    expect(await text(await storage.get('abc-123'))).toBe('hello world');
  });

  it('deletes idempotently', async () => {
    await storage.put('to-delete', Readable.from(['x']));
    await storage.delete('to-delete');
    await storage.delete('to-delete');
    await expect(storage.get('to-delete')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves no partial file when the source stream fails', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });
    await expect(storage.put('broken', broken)).rejects.toThrow('connection reset');
    expect(
      (await readdir(path.join(root, 'nested'))).filter((f) => f.startsWith('broken')),
    ).toEqual([]);
    await expect(storage.get('broken')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['../escape', 'a/b', '..', '', '/etc/passwd', 'a\\b', 'x'.repeat(65)])(
    'rejects the key %j',
    async (key) => {
      await expect(storage.put(key, Readable.from(['x']))).rejects.toThrow('Invalid storage key');
      await expect(storage.get(key)).rejects.toThrow('Invalid storage key');
      await expect(storage.delete(key)).rejects.toThrow('Invalid storage key');
    },
  );
});
