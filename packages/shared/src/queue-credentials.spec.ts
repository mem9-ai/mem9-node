import {
  decryptQueueCredential,
  encryptQueueCredential,
  parseQueueEncryptionKeys,
  QUEUE_CREDENTIAL_TTL_SECONDS,
} from './queue-credentials';

const oldKey = `old:${Buffer.alloc(32, 1).toString('base64')}`;
const newKey = `new:${Buffer.alloc(32, 2).toString('base64')}`;
const now = new Date('2026-10-29T02:00:00.000Z');
const scope = {
  reportId: 7,
  apiKeyFingerprintHex: '01'.repeat(32),
  createdAfter: '2026-10-01T00:00:00.000Z',
  createdBefore: '2026-10-14T23:59:59.999Z',
};
const secret = 'synthetic-upstream-credential';
const seal = () => encryptQueueCredential(oldKey, secret, scope, now);
const open = (value: string, at = now) => decryptQueueCredential(oldKey, value, scope, at);

describe('queue credential envelope', () => {
  it('uses randomized authenticated encryption without exposing the credential', () => {
    const first = seal();
    expect(first).not.toContain(secret);
    expect(first).not.toContain(Buffer.from(secret).toString('base64'));
    expect(seal()).not.toBe(first);
    expect(open(first)).toBe(secret);
  });

  it('supports retained read keys while writing only with the first key', () => {
    const old = seal();
    const keyring = `${newKey},${oldKey}`;
    expect(decryptQueueCredential(keyring, old, scope, now)).toBe(secret);
    const current = encryptQueueCredential(keyring, secret, scope, now);
    expect(current.startsWith('v1.new.')).toBe(true);
    expect(decryptQueueCredential(newKey, current, scope, now)).toBe(secret);
    expect(() => decryptQueueCredential(newKey, old, scope, now)).toThrow('Invalid queue credential');
  });

  it.each([
    { reportId: 8 },
    { apiKeyFingerprintHex: '02'.repeat(32) },
    { createdAfter: '2026-10-02T00:00:00.000Z' },
    { createdBefore: '2026-10-13T23:59:59.999Z' },
  ])('rejects a credential copied to a different report, tenant, or range', (override) => {
    expect(() => decryptQueueCredential(oldKey, seal(), { ...scope, ...override }, now))
      .toThrow('Invalid queue credential');
  });

  it('authenticates the key id even if two ids mistakenly share key material', () => {
    const ciphertext = seal().replace('v1.old.', 'v1.alias.');
    expect(() => decryptQueueCredential(`${oldKey},alias:${Buffer.alloc(32, 1).toString('base64')}`, ciphertext, scope, now))
      .toThrow('Invalid queue credential');
  });

  it.each([4, 5, 6])('rejects tampering with nonce, tag, and ciphertext (%s)', (part) => {
    const fields = seal().split('.');
    const bytes = Buffer.from(fields[part]!, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    fields[part] = bytes.toString('base64');
    expect(() => open(fields.join('.'))).toThrow('Invalid queue credential');
  });

  it('expires at admission deadline and permits only a small future clock skew', () => {
    const value = seal();
    expect(open(value, new Date(now.getTime() + QUEUE_CREDENTIAL_TTL_SECONDS * 1000 - 1))).toBe(secret);
    expect(() => open(value, new Date(now.getTime() + QUEUE_CREDENTIAL_TTL_SECONDS * 1000)))
      .toThrow('Invalid queue credential');
    expect(open(value, new Date(now.getTime() - 30000))).toBe(secret);
    expect(() => open(value, new Date(now.getTime() - 31000))).toThrow('Invalid queue credential');
  });

  it('does not permit an attacker to renew both authenticated timestamps', () => {
    const fields = seal().split('.');
    fields[2] = String(Number(fields[2]) + 1);
    fields[3] = String(Number(fields[3]) + 1);
    expect(() => open(fields.join('.'))).toThrow('Invalid queue credential');
  });

  it.each([
    (value: string) => value + '.',
    (value: string) => value + '..',
    (value: string) => value.replace('v1.', 'v2.'),
    (value: string) => value.replace('v1.old.', 'v1.missing.'),
    (value: string) => { const parts = value.split('.'); parts[2] = '0' + parts[2]; return parts.join('.'); },
    (value: string) => { const parts = value.split('.'); parts[3] = String(Number(parts[3]) + 1); return parts.join('.'); },
    (value: string) => { const parts = value.split('.'); parts[4] = parts[4] + '='; return parts.join('.'); },
    (value: string) => { const parts = value.split('.'); parts[5] = Buffer.alloc(12).toString('base64'); return parts.join('.'); },
    (value: string) => { const parts = value.split('.'); parts[6] = ''; return parts.join('.'); },
    () => 'x'.repeat(6001),
    () => 'plain-api-key',
  ])('fails closed on malformed or unversioned envelopes without a sensitive cause', (mutate) => {
    try {
      open(mutate(seal()));
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ message: 'Invalid queue credential', code: 'INVALID_QUEUE_CREDENTIAL' });
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each(['', ' ', 'x'.repeat(4097)])('rejects empty and oversized upstream credentials', (value) => {
    expect(() => encryptQueueCredential(oldKey, value, scope, now)).toThrow('Invalid queue credential');
  });

  it.each([undefined, '', 'id:weak', oldKey + ':', oldKey + ',', `${oldKey},${oldKey}`,
    `bad.id:${Buffer.alloc(32).toString('base64')}`, `id:${Buffer.alloc(31).toString('base64')}`,
    `id:${Buffer.alloc(32).toString('base64').slice(0, -1)}`,
    Array.from({ length: 9 }, (_, i) => `key${i}:${Buffer.alloc(32, i).toString('base64')}`).join(','),
  ])('rejects invalid keyrings without echoing their values', (value) => {
    try {
      parseQueueEncryptionKeys(value);
      throw new Error('Expected rejection');
    } catch (error) {
      expect((error as Error).message).toBe('Invalid QUEUE_ENCRYPTION_KEYS configuration');
    }
  });
});
