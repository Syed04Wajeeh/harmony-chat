import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerClient } from '../../src/docker.ts';
import {
  containerExists,
  containerState,
  startThrowaway,
  type Throwaway,
} from './docker-helpers.ts';

/** Real docker-socket-proxy, real daemon, throwaway `sleep` containers. Needs Docker. */
describe('docker socket proxy rules', () => {
  let t: Throwaway;
  beforeAll(() => {
    t = startThrowaway();
  });
  afterAll(() => t?.cleanup());

  const call = async (method: string, path: string) => {
    const res = await fetch(t.proxyUrl + path, { method });
    await res.arrayBuffer();
    return res.status;
  };

  it('answers the four requests the bot makes', async () => {
    expect(await call('GET', '/containers/json?all=1')).toBe(200);
    expect(await call('GET', `/containers/${t.control}/json`)).toBe(200);
    expect(await call('GET', `/containers/${t.statusOnly}/json`)).toBe(200);
    expect(await call('POST', `/containers/${t.control}/restart?t=1`)).toBe(204);
    expect(await call('POST', `/containers/${t.control}/stop?t=1`)).toBe(204);
    expect(containerState(t.control)).toBe('exited');
    expect(await call('POST', `/containers/${t.control}/start`)).toBe(204);
    expect(containerState(t.control)).toBe('running');
  });

  it('refuses control of a container that is only listed for status, and unknown ones', async () => {
    expect(await call('POST', `/containers/${t.statusOnly}/restart`)).toBe(403);
    expect(await call('POST', `/containers/${t.statusOnly}/stop`)).toBe(403);
    expect(await call('POST', `/containers/${t.other}/restart`)).toBe(403);
    expect(await call('GET', `/containers/${t.other}/json`)).toBe(403);
    expect(containerState(t.statusOnly)).toBe('running');
    expect(containerState(t.other)).toBe('running');
  });

  it('refuses a container id where a name is required', async () => {
    const id = containerStateId(t.control);
    expect(await call('POST', `/containers/${id}/restart`)).toBe(403);
    expect(await call('GET', `/containers/${id}/json`)).toBe(403);
  });

  it('refuses create, delete, exec, kill and every other container verb, even for the control container', async () => {
    const refused: [string, string][] = [
      ['POST', '/containers/create?name=hb-evil'],
      ['DELETE', `/containers/${t.control}`],
      ['DELETE', `/containers/${t.control}?force=true`],
      ['POST', `/containers/${t.control}/exec`],
      ['POST', `/containers/${t.control}/kill`],
      ['POST', `/containers/${t.control}/pause`],
      ['POST', `/containers/${t.control}/unpause`],
      ['POST', `/containers/${t.control}/rename?name=x`],
      ['POST', `/containers/${t.control}/update`],
      ['POST', `/containers/${t.control}/wait`],
      ['POST', `/containers/${t.control}/attach`],
      ['POST', `/containers/${t.control}/resize`],
      ['POST', '/containers/prune'],
      ['GET', `/containers/${t.control}/logs?stdout=1`],
      ['GET', `/containers/${t.control}/archive?path=/etc/passwd`],
      ['GET', `/containers/${t.control}/export`],
      ['GET', `/containers/${t.control}/top`],
      ['GET', `/containers/${t.control}/changes`],
      ['PUT', `/containers/${t.control}/archive?path=/`],
      ['PUT', `/containers/${t.control}/restart`],
      ['GET', `/containers/${t.control}/restart`],
      ['POST', '/containers/json'],
      ['POST', `/containers/${t.control}/json`],
      ['HEAD', `/containers/${t.control}/archive?path=/`],
    ];
    for (const [method, path] of refused) {
      expect(await call(method, path), `${method} ${path}`).toBe(403);
    }
    expect(containerExists(t.control)).toBe(true);
    expect(containerState(t.control)).toBe('running');
  });

  it('refuses the rest of the Docker API', async () => {
    const refused: [string, string][] = [
      ['GET', '/version'],
      ['GET', '/info'],
      ['GET', '/_ping'],
      ['GET', '/events'],
      ['GET', '/images/json'],
      ['POST', '/images/create?fromImage=alpine'],
      ['GET', '/volumes'],
      ['GET', '/networks'],
      ['POST', '/networks/create'],
      ['GET', '/system/df'],
      ['GET', '/swarm'],
      ['GET', '/secrets'],
      ['GET', '/plugins'],
      ['POST', '/build'],
      ['POST', '/exec/abc/start'],
      ['GET', '/exec/abc/json'],
      ['POST', '/session'],
    ];
    for (const [method, path] of refused) {
      expect(await call(method, path), `${method} ${path}`).toBe(403);
    }
  });

  it('refuses version prefixes, traversal and encoded tricks', async () => {
    const refused: [string, string][] = [
      ['POST', `/v1.45/containers/${t.control}/restart`],
      ['GET', '/v1.45/containers/json'],
      ['POST', `/containers/${t.control}/../${t.other}/restart`],
      ['POST', `/containers/${t.control}%2f..%2f${t.other}/restart`],
      ['POST', `/containers/%2e%2e/containers/${t.other}/restart`],
      ['POST', `/containers/${t.control}/%2e%2e/${t.other}/restart`],
      ['POST', `//containers/${t.control}/restart`],
      ['POST', `/containers/${t.control}/restart/extra`],
      ['POST', `/containers/${t.control}/restartx`],
      ['POST', `/containers/${t.control.toUpperCase()}/restart`],
      ['GET', '/containers/json/../../info'],
    ];
    // HAProxy resolves dot segments before its rules run, so a traversal is judged as the path it
    // becomes: every one of these ends up at a container that is not controllable.
    for (const [method, path] of refused) {
      const status = await call(method, path);
      expect(status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    expect(containerState(t.other)).toBe('running');
  });

  it('works with the bot client end to end', async () => {
    const client = new DockerClient(t.proxyUrl, { control: [t.control], status: [t.statusOnly] });
    const names = (await client.list()).map((c) => c.name);
    expect(names).toEqual([t.control, t.statusOnly]); // the "other" container is invisible
    expect(await client.act('restart', t.control)).toBe('done');
    expect((await client.inspect(t.control)).state).toBe('running');
    expect(await client.act('start', t.control)).toBe('unchanged');
    await expect(client.act('restart', t.statusOnly)).rejects.toThrow(
      /not something this bot controls/,
    );
    await expect(client.act('restart', t.other)).rejects.toThrow(/not something this bot controls/);
  });
});

function containerStateId(name: string): string {
  return execFileSync('docker', ['inspect', '--format', '{{.Id}}', name], {
    encoding: 'utf8',
  }).trim();
}
