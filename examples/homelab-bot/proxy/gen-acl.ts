// Writes the two name lists the proxy's HAProxy rules read, from the bot's config file.
//   node proxy/gen-acl.ts [config.yml] [output directory, default proxy/acl]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_NAME } from '../src/docker.ts';
import { readConfigFile } from '../src/config.ts';

export function aclFiles(raw: Record<string, unknown>): { visible: string; control: string } {
  const docker = (raw.docker ?? {}) as { control?: unknown; status?: unknown };
  const names = (value: unknown): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error('docker.control and docker.status must be lists');
    return value.map((name) => {
      if (typeof name !== 'string' || !CONTAINER_NAME.test(name)) {
        throw new Error(`"${String(name)}" is not a valid container name`);
      }
      return name;
    });
  };
  const control = names(docker.control);
  const status = names(docker.status);
  const lines = (list: string[]) => (list.length > 0 ? `${list.join('\n')}\n` : '');
  return { control: lines(control), visible: lines([...control, ...status]) };
}

if (import.meta.main) {
  const file = process.argv[2] ?? 'config.yml';
  const out = process.argv[3] ?? 'proxy/acl';
  const files = aclFiles(readConfigFile(file));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'control.txt'), files.control);
  writeFileSync(join(out, 'visible.txt'), files.visible);
  console.log(`wrote ${join(out, 'control.txt')} and ${join(out, 'visible.txt')}`);
}
