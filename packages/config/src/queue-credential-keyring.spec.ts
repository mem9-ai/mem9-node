import { randomBytes } from 'node:crypto';

import { parseQueueCredentialKeyring } from './queue-credential-keyring';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

function keyring(value: unknown): string {
  return JSON.stringify(value);
}

describe('parseQueueCredentialKeyring', () => {
  it('parses the mem9#483 encryption subset and exposes the active kid', () => {
    const parsed = parseQueueCredentialKeyring(
      keyring({ encryption_kid: 'k2', encryption_keys: { k1, k2 } }),
    );

    expect(parsed.activeKid).toBe('k2');
    expect([...parsed.keys.keys()].sort()).toEqual(['k1', 'k2']);
    expect(parsed.keys.get('k1')).toEqual(Buffer.from(k1, 'base64'));
    expect(parsed.keys.get('k2')!.length).toBe(32);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['not JSON', 'k1:abc'],
    ['JSON array', '[]'],
    ['JSON null', 'null'],
    ['missing encryption_kid', keyring({ encryption_keys: { k1 } })],
    ['missing encryption_keys', keyring({ encryption_kid: 'k1' })],
    ['active kid not present', keyring({ encryption_kid: 'k9', encryption_keys: { k1 } })],
    ['empty key map', keyring({ encryption_kid: 'k1', encryption_keys: {} })],
    ['short key', keyring({ encryption_kid: 'k1', encryption_keys: { k1: randomBytes(16).toString('base64') } })],
    ['long key', keyring({ encryption_kid: 'k1', encryption_keys: { k1: randomBytes(33).toString('base64') } })],
    ['non-canonical base64', keyring({ encryption_kid: 'k1', encryption_keys: { k1: `${k1.slice(0, -1)}\n=` } })],
    ['base64url instead of std base64', keyring({
      encryption_kid: 'k1',
      encryption_keys: { k1: Buffer.from(Array.from({ length: 32 }, () => 0xfb)).toString('base64url') },
    })],
    ['non-string key', keyring({ encryption_kid: 'k1', encryption_keys: { k1: 42 } })],
    ['invalid kid characters', keyring({ encryption_kid: 'k 1', encryption_keys: { 'k 1': k1 } })],
    ['kid too long', keyring({ encryption_kid: 'k'.repeat(65), encryption_keys: { ['k'.repeat(65)]: k1 } })],
    ['duplicate key bytes under two kids', keyring({ encryption_kid: 'k1', encryption_keys: { k1, k2: k1 } })],
    ['too many keys', keyring({
      encryption_kid: 'k0',
      encryption_keys: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`k${index}`, randomBytes(32).toString('base64')]),
      ),
    })],
    // mem9's own keyring must never be reused here; its HMAC fields are rejected outright.
    ['mem9 keyring with hmac_keys', keyring({
      hash_version: 'v1',
      hmac_keys: { v1: k2 },
      encryption_kid: 'k1',
      encryption_keys: { k1 },
    })],
    ['unknown extra field', keyring({ encryption_kid: 'k1', encryption_keys: { k1 }, note: 'x' })],
  ])('rejects %s', (_label, value) => {
    expect(() => parseQueueCredentialKeyring(value)).toThrow(
      'Invalid QUEUE_CREDENTIAL_KEYRING configuration',
    );
  });

  it('never echoes key material in its error', () => {
    const secret = randomBytes(16).toString('base64');
    let message = '';
    try {
      parseQueueCredentialKeyring(keyring({ encryption_kid: 'k1', encryption_keys: { k1: secret } }));
    } catch (error) {
      message = error instanceof Error ? `${error.message} ${String(error.stack)}` : String(error);
    }

    expect(message).toContain('Invalid QUEUE_CREDENTIAL_KEYRING configuration');
    expect(message).not.toContain(secret);
  });
});
