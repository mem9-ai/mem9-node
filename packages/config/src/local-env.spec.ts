import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('local environment preload', () => {
  let root: string;
  let loader: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mem9-local-env-'));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
    loader = join(root, 'scripts', 'load-local-env.cjs');
    copyFileSync(resolve(__dirname, '../../../scripts/load-local-env.cjs'), loader);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function readFixture(env: NodeJS.ProcessEnv = {}): string {
    return execFileSync(process.execPath, [
      '--require', loader, '-e',
      'process.stdout.write(process.env.MEM9_ENV_TEST_VALUE || "missing")',
    ], { cwd: join(root, 'apps', 'api'), env, encoding: 'utf8' });
  }

  it('loads the repository env file from a workspace directory', () => {
    writeFileSync(join(root, '.env'), 'MEM9_ENV_TEST_VALUE=from-file\n');
    expect(readFixture()).toBe('from-file');
  });

  it('preserves explicitly exported values', () => {
    writeFileSync(join(root, '.env'), 'MEM9_ENV_TEST_VALUE=from-file\n');
    expect(readFixture({ MEM9_ENV_TEST_VALUE: 'exported' })).toBe('exported');
  });

  it('supports commands without a local env file', () => {
    expect(readFixture()).toBe('missing');
    expect(readFixture({ MEM9_ENV_TEST_VALUE: 'exported' })).toBe('exported');
  });
});
