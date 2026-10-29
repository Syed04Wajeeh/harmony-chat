import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aclFiles } from '../../proxy/gen-acl.ts';
import {
  buildConfig,
  ConfigError,
  parseKuma,
  readConfigFile,
  redactor,
  secretsOf,
} from '../../src/config.ts';
import { PROXY, PTERO, PTERO_KEY, TOKEN } from './helpers.ts';

const env = {
  HARMONY_BOT_TOKEN: TOKEN,
  DASHBOARD_CHANNEL: 'dash',
  HARMONY_URL: 'http://harmony:8081',
};

describe('configuration', () => {
  it('reads YAML or JSON and lets the environment win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-cfg-'));
    writeFileSync(
      join(dir, 'c.yml'),
      'harmony:\n  rolePermission: manage_channels\n  opsChannel: ops\ndocker:\n  proxyUrl: http://p:2375\n  control: [a]\n  status: [b]\n',
    );
    writeFileSync(
      join(dir, 'c.json'),
      JSON.stringify({ docker: { proxyUrl: 'http://p:2375', control: ['a'] } }),
    );
    const yml = buildConfig(readConfigFile(join(dir, 'c.yml')), env);
    expect(yml.harmony.rolePermission).toBe('manage_channels');
    expect(yml.docker).toMatchObject({ control: ['a'], status: ['b'] });
    expect(buildConfig(readConfigFile(join(dir, 'c.json')), env).docker.control).toEqual(['a']);
    const overridden = buildConfig(readConfigFile(join(dir, 'c.yml')), {
      ...env,
      ROLE_PERMISSION: 'manage_guild',
      DOCKER_PROXY_URL: 'http://other:1/',
    });
    expect(overridden.harmony.rolePermission).toBe('manage_guild');
    expect(overridden.docker.proxyUrl).toBe('http://other:1');
  });

  it('defaults to manage_guild, 30 s refresh and 30 s cooldown', () => {
    const c = buildConfig({}, env);
    expect(c).toMatchObject({
      refreshSeconds: 30,
      cooldownSeconds: 30,
      harmony: { rolePermission: 'manage_guild' },
    });
  });

  it.each([
    [{}, { ...env, HARMONY_BOT_TOKEN: undefined }, /HARMONY_BOT_TOKEN/],
    [{}, { ...env, HARMONY_BOT_TOKEN: 'nope' }, /malformed/],
    [{}, { ...env, DASHBOARD_CHANNEL: undefined }, /DASHBOARD_CHANNEL/],
    [{}, { ...env, HARMONY_URL: 'ftp://x' }, /http or https/],
    [{ docker: { control: ['a'] } }, env, /DOCKER_PROXY_URL/],
    [
      { docker: { proxyUrl: 'http://p', control: ['a'], status: ['a'] } },
      env,
      /both control and status/,
    ],
    [{ pterodactyl: { url: 'http://x' } }, env, /PTERODACTYL_CLIENT_API_KEY/],
    [{ docker: { control: 'a' } }, env, /list of strings/],
    [{ refreshSeconds: 0 }, env, /refreshSeconds/],
  ])('rejects a bad configuration %#', (raw, e, message) => {
    expect(() => buildConfig(raw as never, e)).toThrow(ConfigError);
    expect(() => buildConfig(raw as never, e)).toThrow(message);
  });

  it('takes the Kuma status page as a URL or as a base plus a slug', () => {
    expect(parseKuma('http://kuma:3001/status/home', undefined)).toEqual({
      baseUrl: 'http://kuma:3001',
      slug: 'home',
    });
    expect(parseKuma('http://h/kuma/status/main', undefined)).toEqual({
      baseUrl: 'http://h/kuma',
      slug: 'main',
    });
    expect(parseKuma('http://kuma:3001', 'home')).toEqual({
      baseUrl: 'http://kuma:3001',
      slug: 'home',
    });
    expect(() => parseKuma('http://kuma:3001', undefined)).toThrow(/slug/);
  });

  it('never leaves the secrets in a redacted line', () => {
    const c = buildConfig(
      { docker: { proxyUrl: PROXY }, pterodactyl: { url: PTERO } },
      { ...env, PTERODACTYL_CLIENT_API_KEY: PTERO_KEY },
    );
    const redact = redactor(secretsOf(c));
    const line = `failed ${TOKEN} to ${PROXY}/containers via docker-proxy-secret-host:2375 key=${PTERO_KEY} at ${PTERO}`;
    const out = redact(line);
    for (const s of [TOKEN, PTERO_KEY, 'docker-proxy-secret-host', 'panel-secret-host'])
      expect(out).not.toContain(s);
  });
});

describe('proxy ACL files', () => {
  it('lists control names and control+status names, and rejects odd names', () => {
    expect(aclFiles({ docker: { control: ['a', 'b'], status: ['c'] } })).toEqual({
      control: 'a\nb\n',
      visible: 'a\nb\nc\n',
    });
    expect(aclFiles({})).toEqual({ control: '', visible: '' });
    expect(() => aclFiles({ docker: { control: ['a\nb'] } })).toThrow(/not a valid container name/);
    expect(() => aclFiles({ docker: { control: ['../x'] } })).toThrow();
  });
});
