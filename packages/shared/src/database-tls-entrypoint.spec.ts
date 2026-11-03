import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, '../../../scripts/database-tls-url.cjs');
const certificate = resolve(__dirname, '../../../prisma/certs/rds-global-bundle.pem');

function run(databaseUrl: string, ca = certificate) {
  return spawnSync(process.execPath, [script], {
    env: { DATABASE_URL: databaseUrl, DATABASE_TLS_CA_FILE: ca },
    encoding: 'utf8',
  });
}

describe('database TLS connection bootstrap', () => {
  it('requires certificate verification without changing credentials, database, or pool options', () => {
    const original = new URL('mysql://tenant:p%40ss%3Aword@db.example:3306/mem9?connection_limit=3&sslaccept=accept_invalid_certs&sslaccept=accept_invalid_certs');
    const result = run(original.toString());
    expect(result.status).toBe(0);
    const secured = new URL(result.stdout);
    for (const field of ['username', 'password', 'hostname', 'port', 'pathname'] as const) {
      expect(secured[field]).toBe(original[field]);
    }
    expect(secured.searchParams.get('connection_limit')).toBe('3');
    expect(secured.searchParams.getAll('sslaccept')).toEqual(['strict']);
    expect(secured.searchParams.get('sslcert')).toBe(certificate);
    expect(result.stderr).toBe('');
  });

  it.each([
    ['mysql://user:secret-value@db/mem9', '/missing-ca.pem'],
    ['invalid-secret-value', certificate],
    ['postgresql://user:secret-value@db/mem9', certificate],
  ])('fails closed without printing credentials when configuration is invalid', (url, ca) => {
    const result = run(url, ca);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Database TLS configuration is invalid or its CA file is unreadable\n');
    expect(result.stderr).not.toContain('secret-value');
  });

  it('preserves the local development URL when TLS has not been configured', () => {
    const url = 'mysql://mem9:mem9@127.0.0.1:3306/mem9';
    const result = run(url, '');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(url);
  });
});
