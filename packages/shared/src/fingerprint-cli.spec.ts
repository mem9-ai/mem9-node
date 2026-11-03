import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import path from 'node:path';

const script = path.resolve(__dirname, '../../../scripts/derive-api-key-fingerprint.mjs');
const pepper = 'cli-test-pepper-1234567890';
const key = 'cli-test-api-key';

describe('fingerprint CLI secret input', () => {
  it('rejects positional keys without echoing them', () => {
    const result = spawnSync(process.execPath, [script, key], {
      env: { APP_PEPPER: pepper }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('standard input');
    expect(result.stderr).not.toContain(key);
  });

  it('preserves fingerprint output for a key supplied through stdin', () => {
    const result = spawnSync(process.execPath, [script], {
      env: { APP_PEPPER: pepper }, input: `${key}\n`, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${createHmac('sha256', pepper).update(key).digest('hex')}\n`);
    expect(result.stderr).toBe('');
  });

  it('fails on empty input without suggesting a key in command-line arguments', () => {
    const result = spawnSync(process.execPath, [script], {
      env: { APP_PEPPER: pepper }, input: '', encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('standard input');
    expect(result.stderr).not.toContain('-- <x-mem9-api-key>');
  });
});
