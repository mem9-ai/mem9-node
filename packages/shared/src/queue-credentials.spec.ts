import { createDecipheriv, randomBytes } from 'node:crypto';

import { parseQueueCredentialKeyring } from '@mem9/config';

import { AppError } from './errors';
import {
  QUEUE_CREDENTIAL_TTL_SECONDS,
  openQueueCredential,
  sealQueueCredential,
  type QueueCredentialScope,
} from './queue-credentials';

const API_KEY = 'mk_queue_secret_key_value_123';
const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
const keyring = parseQueueCredentialKeyring(
  JSON.stringify({ encryption_kid: 'k1', encryption_keys: { k1 } }),
);
const scope: QueueCredentialScope = {
  reportId: 42,
  apiKeyFingerprintHex: 'ab'.repeat(32),
  createdAfter: '2026-06-01T00:00:00.000Z',
  createdBefore: '2026-06-14T23:59:59.999Z',
};
const now = new Date('2026-10-29T08:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);

interface Envelope {
  v: number;
  kid: string;
  iat: number;
  exp: number;
  nonce: string;
  ciphertext: string;
}

function seal(overrides?: { apiKey?: string; scope?: QueueCredentialScope; at?: Date }): string {
  return sealQueueCredential(keyring, overrides?.apiKey ?? API_KEY, overrides?.scope ?? scope, overrides?.at ?? now);
}

function parse(envelope: string): Envelope {
  return JSON.parse(envelope) as Envelope;
}

function expectRejected(fn: () => unknown): AppError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  const error = caught as AppError;
  expect(error.statusCode).toBe(403);
  expect(error.code).toBe('INVALID_QUEUE_CREDENTIAL');
  expect(error.cause).toBeUndefined();
  expect(`${error.message} ${JSON.stringify(error.details ?? {})}`).not.toContain(API_KEY);
  return error;
}

describe('queue credentials', () => {
  it('uses the configured 10 minute admission lifetime', () => {
    expect(QUEUE_CREDENTIAL_TTL_SECONDS).toBe(600);
  });

  it('round-trips the key for the same scope', () => {
    const envelope = seal();

    expect(openQueueCredential(keyring, envelope, scope, now)).toBe(API_KEY);
  });

  it('never contains the plaintext key', () => {
    const envelope = seal();

    expect(envelope).not.toContain(API_KEY);
    expect(Buffer.from(parse(envelope).ciphertext, 'base64').toString('utf8')).not.toContain(API_KEY);
  });

  it('emits the mem9#483-style JSON envelope with issue/expiry fields', () => {
    const envelope = parse(seal());

    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'exp', 'iat', 'kid', 'nonce', 'v']);
    expect(envelope.v).toBe(1);
    expect(envelope.kid).toBe('k1');
    expect(envelope.iat).toBe(nowSeconds);
    expect(envelope.exp).toBe(nowSeconds + 600);
    expect(Buffer.from(envelope.nonce, 'base64')).toHaveLength(12);
    // ciphertext || 16-byte GCM tag, like Go's AEAD.Seal output.
    expect(Buffer.from(envelope.ciphertext, 'base64')).toHaveLength(Buffer.byteLength(API_KEY) + 16);
  });

  it('pins the documented AES-256-GCM layout and AAD', () => {
    const envelope = parse(seal());
    const sealed = Buffer.from(envelope.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(k1, 'base64'), Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(Buffer.from(
      `mem9-node-queue-credential:v1:${JSON.stringify([
        envelope.kid,
        envelope.iat,
        envelope.exp,
        scope.reportId,
        scope.apiKeyFingerprintHex,
        scope.createdAfter,
        scope.createdBefore,
      ])}`,
    ));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);

    expect(plaintext.toString('utf8')).toBe(API_KEY);
  });

  it('uses a fresh nonce for every seal', () => {
    expect(parse(seal()).nonce).not.toBe(parse(seal()).nonce);
  });

  describe('scope binding', () => {
    it.each([
      ['reportId', { ...scope, reportId: 43 }],
      ['owner fingerprint', { ...scope, apiKeyFingerprintHex: 'cd'.repeat(32) }],
      ['createdAfter', { ...scope, createdAfter: '2026-06-02T00:00:00.000Z' }],
      ['createdBefore', { ...scope, createdBefore: '2026-06-13T23:59:59.999Z' }],
    ])('rejects an envelope replayed with a different %s', (_label, otherScope) => {
      const envelope = seal();

      expectRejected(() => openQueueCredential(keyring, envelope, otherScope, now));
    });
  });

  describe('envelope tampering', () => {
    const mutate = (patch: Record<string, unknown>) =>
      JSON.stringify({ ...parse(seal()), ...patch });

    it.each([
      ['kid swapped to another valid key', () => {
        const rotated = parseQueueCredentialKeyring(
          JSON.stringify({ encryption_kid: 'k1', encryption_keys: { k1, k2 } }),
        );
        return { ring: rotated, envelope: mutate({ kid: 'k2' }) };
      }],
      ['iat moved', () => ({ ring: keyring, envelope: mutate({ iat: nowSeconds - 1, exp: nowSeconds + 599 }) })],
      ['exp extended', () => ({ ring: keyring, envelope: mutate({ exp: nowSeconds + 3600 }) })],
      ['ciphertext bit flipped', () => {
        const envelope = parse(seal());
        const bytes = Buffer.from(envelope.ciphertext, 'base64');
        bytes[0] = bytes[0]! ^ 0x01;
        return { ring: keyring, envelope: JSON.stringify({ ...envelope, ciphertext: bytes.toString('base64') }) };
      }],
      ['tag truncated', () => {
        const envelope = parse(seal());
        const bytes = Buffer.from(envelope.ciphertext, 'base64');
        return { ring: keyring, envelope: JSON.stringify({ ...envelope, ciphertext: bytes.subarray(0, bytes.length - 1).toString('base64') }) };
      }],
      ['nonce replaced', () => ({ ring: keyring, envelope: mutate({ nonce: randomBytes(12).toString('base64') }) })],
      ['nonce wrong length', () => ({ ring: keyring, envelope: mutate({ nonce: randomBytes(16).toString('base64') }) })],
      ['non-canonical base64', () => ({ ring: keyring, envelope: mutate({ ciphertext: `${parse(seal()).ciphertext}\n` }) })],
      ['unsupported version', () => ({ ring: keyring, envelope: mutate({ v: 2 }) })],
      ['string version', () => ({ ring: keyring, envelope: mutate({ v: '1' }) })],
      ['extra field', () => ({ ring: keyring, envelope: mutate({ apiKey: API_KEY }) })],
      ['missing field', () => {
        const rest: Record<string, unknown> = { ...parse(seal()) };
        delete rest.nonce;
        return { ring: keyring, envelope: JSON.stringify(rest) };
      }],
      ['unknown kid', () => ({ ring: keyring, envelope: mutate({ kid: 'k9' }) })],
      ['not JSON', () => ({ ring: keyring, envelope: 'v1.k1.abc' })],
      ['plaintext key instead of envelope', () => ({ ring: keyring, envelope: API_KEY })],
      ['oversized envelope', () => ({ ring: keyring, envelope: 'x'.repeat(9000) })],
    ])('rejects %s', (_label, build) => {
      const { ring, envelope } = build();

      expectRejected(() => openQueueCredential(ring, envelope, scope, now));
    });

    it.each([undefined, null, 42, {}])('rejects a non-string envelope %p', (value) => {
      expectRejected(() => openQueueCredential(keyring, value as unknown as string, scope, now));
    });
  });

  describe('lifetime', () => {
    it('accepts an envelope just before expiry', () => {
      const envelope = seal();

      expect(openQueueCredential(keyring, envelope, scope, new Date((nowSeconds + 599) * 1000))).toBe(API_KEY);
    });

    it('rejects an expired envelope', () => {
      const envelope = seal();

      expectRejected(() => openQueueCredential(keyring, envelope, scope, new Date((nowSeconds + 600) * 1000)));
    });

    it('tolerates 30 seconds of clock skew but not more', () => {
      const issuedInFuture = seal({ at: new Date((nowSeconds + 30) * 1000) });
      const tooFarInFuture = seal({ at: new Date((nowSeconds + 31) * 1000) });

      expect(openQueueCredential(keyring, issuedInFuture, scope, now)).toBe(API_KEY);
      expectRejected(() => openQueueCredential(keyring, tooFarInFuture, scope, now));
    });
  });

  describe('keys and rotation', () => {
    it('rejects an envelope sealed with a different key under the same kid', () => {
      const other = parseQueueCredentialKeyring(
        JSON.stringify({ encryption_kid: 'k1', encryption_keys: { k1: k2 } }),
      );
      const envelope = sealQueueCredential(other, API_KEY, scope, now);

      expectRejected(() => openQueueCredential(keyring, envelope, scope, now));
    });

    it('seals with the active kid and still opens envelopes from a retained kid', () => {
      const before = parseQueueCredentialKeyring(
        JSON.stringify({ encryption_kid: 'k1', encryption_keys: { k1, k2 } }),
      );
      const after = parseQueueCredentialKeyring(
        JSON.stringify({ encryption_kid: 'k2', encryption_keys: { k1, k2 } }),
      );
      const oldEnvelope = sealQueueCredential(before, API_KEY, scope, now);
      const newEnvelope = sealQueueCredential(after, API_KEY, scope, now);

      expect(parse(oldEnvelope).kid).toBe('k1');
      expect(parse(newEnvelope).kid).toBe('k2');
      expect(openQueueCredential(after, oldEnvelope, scope, now)).toBe(API_KEY);
      expect(openQueueCredential(after, newEnvelope, scope, now)).toBe(API_KEY);
    });
  });

  describe('input validation on seal', () => {
    it.each([
      ['empty key', ''],
      ['whitespace key', '   '],
      ['oversized key', 'k'.repeat(4097)],
    ])('refuses to seal an %s', (_label, apiKey) => {
      expectRejected(() => seal({ apiKey }));
    });

    it.each([
      ['non-positive reportId', { ...scope, reportId: 0 }],
      ['fractional reportId', { ...scope, reportId: 1.5 }],
      ['malformed fingerprint', { ...scope, apiKeyFingerprintHex: 'zz' }],
      ['unparseable date', { ...scope, createdAfter: 'nope' }],
      ['inverted range', { ...scope, createdAfter: scope.createdBefore, createdBefore: scope.createdAfter }],
    ])('refuses to seal with an invalid scope (%s)', (_label, badScope) => {
      expectRejected(() => seal({ scope: badScope }));
    });
  });
});
