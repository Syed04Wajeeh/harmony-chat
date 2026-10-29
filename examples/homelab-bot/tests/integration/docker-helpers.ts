import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { aclFiles } from '../../proxy/gen-acl.ts';

export const PROXY_IMAGE = 'tecnativa/docker-socket-proxy:v0.4.1';
const template = resolve(import.meta.dirname, '../../proxy/haproxy.cfg.template');

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface Throwaway {
  /** Base URL of the test proxy on 127.0.0.1. */
  proxyUrl: string;
  /** Names of the containers created, so a test can look at them. */
  control: string;
  statusOnly: string;
  other: string;
  cleanup: () => void;
}

/**
 * Starts three `sleep` containers and a proxy that allows `control` to be controlled and
 * `statusOnly` to be seen. Everything is named `hb-test-<run>-...` and removed by `cleanup`.
 * Nothing that existed before is touched.
 */
export function startThrowaway(run = Date.now().toString(36)): Throwaway {
  const names = {
    control: `hb-test-${run}-control`,
    statusOnly: `hb-test-${run}-status`,
    other: `hb-test-${run}-other`,
  };
  const proxy = `hb-test-${run}-proxy`;
  const dir = mkdtempSync(join(tmpdir(), 'hb-acl-'));
  const acl = aclFiles({ docker: { control: [names.control], status: [names.statusOnly] } });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'control.txt'), acl.control);
  writeFileSync(join(dir, 'visible.txt'), acl.visible);
  // The test proxy's ACL files must be readable by the proxy's user.
  execFileSync('chmod', ['755', dir]);
  execFileSync('chmod', ['644', join(dir, 'control.txt'), join(dir, 'visible.txt')]);

  const cleanup = () => {
    for (const name of [...Object.values(names), proxy]) {
      try {
        docker('rm', '-f', name);
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (const name of Object.values(names))
      docker('run', '-d', '--name', name, 'alpine', 'sleep', '3600');
    docker(
      'run',
      '-d',
      '--name',
      proxy,
      '--read-only',
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/tmp',
      '-p',
      '127.0.0.1::2375',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock:ro',
      '-v',
      `${template}:/usr/local/etc/haproxy/haproxy.cfg.template:ro`,
      '-v',
      `${dir}:/usr/local/etc/haproxy/acl:ro`,
      PROXY_IMAGE,
    );
    const port = docker('port', proxy, '2375/tcp').split('\n')[0]?.split(':').pop();
    return { proxyUrl: `http://127.0.0.1:${String(port)}`, ...names, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export const containerState = (name: string): string =>
  docker('inspect', '--format', '{{.State.Status}}', name);
export const containerExists = (name: string): boolean => {
  try {
    docker('inspect', name);
    return true;
  } catch {
    return false;
  }
};
