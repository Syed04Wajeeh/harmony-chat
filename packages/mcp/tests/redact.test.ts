import { describe, expect, it } from 'vitest';
import { describeActivity, describeCommand, redact, redactText, shortPath } from '../src/redact.js';

describe('redact', () => {
  const secrets = [
    'hb_12_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz',
    'xoxb-1234567890-abcdefghij',
    'sk-ant-api03-abcdefghijklmnopqrstuv',
    'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  ];

  it.each(secrets)('removes the token-shaped string %s', (secret) => {
    const result = redact(`curl -s -d ${secret} https://example.com`);
    expect(result.text).not.toContain(secret);
    expect(result.changed).toBe(true);
  });

  it('masks values of secret-named variables, flags and headers', () => {
    expect(redactText('API_KEY=abc123 DB_PASSWORD="p w d" ./run')).toBe(
      'API_KEY=[redacted] DB_PASSWORD=[redacted] ./run',
    );
    expect(redactText('tool --password hunter2 --token=zzz --verbose')).toBe(
      'tool --password=[redacted] --token=[redacted] --verbose',
    );
    expect(redactText('curl -H "Authorization: Bearer abcdefghijkl" x')).not.toContain(
      'abcdefghijkl',
    );
    expect(redactText('git clone https://bob:s3cret@host.example/r.git')).toBe(
      'git clone https://[redacted]@host.example/r.git',
    );
  });

  it('masks long mixed blobs but keeps ordinary paths and words', () => {
    expect(
      redactText('x 4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a'),
    ).toContain('[redacted]');
    expect(
      redactText('/home/user/projects/very/long/path/name/with/many/segments/file.ts'),
    ).toContain('segments');
    expect(redactText('pnpm --filter @harmony/server exec vitest run')).toBe(
      'pnpm --filter @harmony/server exec vitest run',
    );
  });

  it('removes private key blocks', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactText(`echo "${key}" > k`)).not.toContain('abc');
  });
});

describe('describeCommand', () => {
  it('shows an ordinary command, one line, clipped', () => {
    expect(describeCommand('pnpm test:unit\n  --reporter=dot')).toBe(
      'pnpm test:unit --reporter=dot',
    );
    expect(describeCommand('x'.repeat(300))).toHaveLength(90);
  });

  it('shows only the first word of a command that carried a secret', () => {
    const shown = describeCommand('deploy --api-key sk-ant-api03-abcdefghijklmnopqrstuv now');
    expect(shown).toBe('deploy … [arguments withheld: contained a secret]');
  });

  it.each([
    'env',
    'printenv | sort',
    'cat .env',
    'cat ~/.ssh/id_ed25519',
    'grep TOKEN .env.local',
    'echo $GITHUB_TOKEN',
    'docker inspect web',
  ])('withholds %s', (command) => {
    expect(describeCommand(command)).toBe('[command withheld: may expose secrets]');
  });
});

describe('describeActivity', () => {
  const cwd = '/work/shop';
  it('names files relative to the working folder and never shows contents', () => {
    expect(
      describeActivity(
        'Edit',
        { file_path: '/work/shop/apps/server/src/x.ts', new_string: 'SECRET=1' },
        cwd,
      ),
    ).toBe('Edit apps/server/src/x.ts');
    expect(
      describeActivity('Write', { file_path: '/etc/deep/other/y.conf', content: 'x' }, cwd),
    ).toBe('Write …/other/y.conf');
    expect(shortPath('/work/shop/a.ts', cwd)).toBe('a.ts');
  });

  it('describes Bash, search, web and subagent calls without their payloads', () => {
    expect(describeActivity('Bash', { command: 'pnpm test:unit' }, cwd)).toBe(
      'Bash: pnpm test:unit',
    );
    expect(describeActivity('Grep', { pattern: 'TODO' }, cwd)).toBe('Grep TODO');
    expect(
      describeActivity('WebFetch', { url: 'https://user:pw@docs.example.com/a?token=1' }, cwd),
    ).toBe('WebFetch docs.example.com');
    expect(
      describeActivity('Agent', { description: 'B+C worker', prompt: 'long secret prompt' }, cwd),
    ).toBe('Starting subagent: B+C worker');
  });

  it('shows only the name of tools it does not know', () => {
    expect(describeActivity('mcp__db__query', { sql: 'select password from users' }, cwd)).toBe(
      'mcp__db__query',
    );
  });
});
