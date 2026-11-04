import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

import type { QueueCredentialKeyring } from '@mem9/config';

import { AppError } from './errors';

export const QUEUE_CREDENTIAL_TTL_SECONDS = 600;

const QUEUE_CREDENTIAL_PREFIX = 'mem9-node-queue-credential:v1:';
const CLOCK_SKEW_SECONDS = 30;
const MAX_PLAINTEXT_BYTES = 4096;
const MAX_ENVELOPE_CHARS = 8192;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ENVELOPE_FIELDS = ['v', 'kid', 'iat', 'exp', 'nonce', 'ciphertext'];

export interface QueueCredentialScope {
  reportId: number;
  apiKeyFingerprintHex: string;
  createdAfter: string;
  createdBefore: string;
}

interface QueueCredentialEnvelope {
  v: number;
  kid: string;
  iat: number;
  exp: number;
  nonce: string;
  ciphertext: string;
}

function invalidCredential(): AppError {
  return new AppError('Invalid queue credential', {
    statusCode: 403,
    code: 'INVALID_QUEUE_CREDENTIAL',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function validateScope(scope: QueueCredentialScope): void {
  if (!Number.isSafeInteger(scope.reportId) || scope.reportId <= 0
    || typeof scope.apiKeyFingerprintHex !== 'string'
    || !FINGERPRINT_PATTERN.test(scope.apiKeyFingerprintHex)
    || typeof scope.createdAfter !== 'string'
    || typeof scope.createdBefore !== 'string'
    || scope.createdAfter.length > 64
    || scope.createdBefore.length > 64
    || !Number.isFinite(Date.parse(scope.createdAfter))
    || !Number.isFinite(Date.parse(scope.createdBefore))
    || !(Date.parse(scope.createdAfter) < Date.parse(scope.createdBefore))) {
    throw invalidCredential();
  }
}

function aad(
  kid: string,
  iat: number,
  exp: number,
  scope: QueueCredentialScope,
): Buffer {
  return Buffer.from(
    `${QUEUE_CREDENTIAL_PREFIX}${JSON.stringify([
      kid,
      iat,
      exp,
      scope.reportId,
      scope.apiKeyFingerprintHex,
      scope.createdAfter,
      scope.createdBefore,
    ])}`,
  );
}

export function sealQueueCredential(
  keyring: QueueCredentialKeyring,
  apiKey: string,
  scope: QueueCredentialScope,
  now?: Date,
): string {
  validateScope(scope);

  const key = keyring.keys.get(keyring.activeKid);
  const issuedAt = epochSeconds(now ?? new Date());
  const expiresAt = issuedAt + QUEUE_CREDENTIAL_TTL_SECONDS;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0
    || Buffer.byteLength(apiKey) > MAX_PLAINTEXT_BYTES
    || key === undefined || !Number.isSafeInteger(issuedAt)) {
    throw invalidCredential();
  }

  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(keyring.activeKid, issuedAt, expiresAt, scope));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(apiKey, 'utf8')),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    return JSON.stringify({
      v: 1,
      kid: keyring.activeKid,
      iat: issuedAt,
      exp: expiresAt,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
  } catch {
    throw invalidCredential();
  }
}

export function openQueueCredential(
  keyring: QueueCredentialKeyring,
  envelope: string,
  scope: QueueCredentialScope,
  now?: Date,
): string {
  validateScope(scope);

  if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_CHARS) {
    throw invalidCredential();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    throw invalidCredential();
  }

  if (!isRecord(parsed) || Object.keys(parsed).length !== ENVELOPE_FIELDS.length
    || !ENVELOPE_FIELDS.every((field) => Object.hasOwn(parsed, field))) {
    throw invalidCredential();
  }

  const credential = parsed as unknown as QueueCredentialEnvelope;
  if (credential.v !== 1 || typeof credential.kid !== 'string'
    || !Number.isSafeInteger(credential.iat)
    || !Number.isSafeInteger(credential.exp)
    || typeof credential.nonce !== 'string'
    || typeof credential.ciphertext !== 'string') {
    throw invalidCredential();
  }

  const key = keyring.keys.get(credential.kid);
  if (key === undefined) {
    throw invalidCredential();
  }

  let nonce: Buffer;
  let ciphertext: Buffer;
  try {
    nonce = Buffer.from(credential.nonce, 'base64');
    ciphertext = Buffer.from(credential.ciphertext, 'base64');
  } catch {
    throw invalidCredential();
  }

  const nowSeconds = epochSeconds(now ?? new Date());
  if (nonce.toString('base64') !== credential.nonce || nonce.length !== 12
    || ciphertext.toString('base64') !== credential.ciphertext
    || ciphertext.length < 17
    || credential.exp - credential.iat !== QUEUE_CREDENTIAL_TTL_SECONDS
    || !Number.isSafeInteger(nowSeconds)
    || credential.iat > nowSeconds + CLOCK_SKEW_SECONDS
    || nowSeconds >= credential.exp) {
    throw invalidCredential();
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad(credential.kid, credential.iat, credential.exp, scope));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      decipher.final(),
    ]);

    if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw invalidCredential();
    }
    const decoded = plaintext.toString('utf8');
    if (decoded.trim().length === 0
      || !Buffer.from(decoded, 'utf8').equals(plaintext)) {
      throw invalidCredential();
    }
    return decoded;
  } catch {
    throw invalidCredential();
  }
}
