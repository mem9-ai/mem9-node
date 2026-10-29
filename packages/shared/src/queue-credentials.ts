import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { parseQueueEncryptionKeys } from '@mem9/config';

import { AppError } from './errors';

export { parseQueueEncryptionKeys } from '@mem9/config';

export interface QueueCredentialScope {
  reportId: number;
  apiKeyFingerprintHex: string;
  createdAfter: string;
  createdBefore: string;
}

// Admission lifetime matches the existing queued-report expiry. An admitted
// worker may finish its run, but a delayed or replayed envelope cannot renew it.
export const QUEUE_CREDENTIAL_TTL_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 30;
const MAX_CREDENTIAL_BYTES = 4096;
const MAX_ENVELOPE_CHARACTERS = 6000;

function invalidCredential(): AppError {
  return new AppError('Invalid queue credential', { statusCode: 403, code: 'INVALID_QUEUE_CREDENTIAL' });
}

function validateScope(scope: QueueCredentialScope): void {
  if (typeof scope.apiKeyFingerprintHex !== 'string'
    || typeof scope.createdAfter !== 'string' || scope.createdAfter.length > 64
    || typeof scope.createdBefore !== 'string' || scope.createdBefore.length > 64) throw invalidCredential();
  const start = Date.parse(scope.createdAfter);
  const end = Date.parse(scope.createdBefore);
  if (!Number.isSafeInteger(scope.reportId) || scope.reportId <= 0
    || !/^[a-f0-9]{64}$/.test(scope.apiKeyFingerprintHex)
    || !Number.isFinite(start) || !Number.isFinite(end) || start >= end
    || end - start > 14 * 24 * 60 * 60 * 1000) throw invalidCredential();
}

function aad(scope: QueueCredentialScope, keyId: string, issuedAt: number, expiresAt: number): Buffer {
  validateScope(scope);
  return Buffer.from(JSON.stringify([
    'memory_analysis_report', 'v1', keyId, issuedAt, expiresAt,
    scope.reportId, scope.apiKeyFingerprintHex, scope.createdAfter, scope.createdBefore,
  ]));
}

function decodeCanonical(value: string, exactLength?: number): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (!value || bytes.toString('base64') !== value
    || (exactLength !== undefined && bytes.length !== exactLength)) throw invalidCredential();
  return bytes;
}

function epochSeconds(now: Date): number {
  const value = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(value) || value < 0) throw invalidCredential();
  return value;
}

export function encryptQueueCredential(
  keysValue: string | undefined,
  apiKey: string,
  scope: QueueCredentialScope,
  now = new Date(),
): string {
  const [id, key] = [...parseQueueEncryptionKeys(keysValue)][0]!;
  if (typeof apiKey !== 'string' || !apiKey.trim()
    || Buffer.byteLength(apiKey, 'utf8') > MAX_CREDENTIAL_BYTES) throw invalidCredential();
  const issuedAt = epochSeconds(now);
  const expiresAt = issuedAt + QUEUE_CREDENTIAL_TTL_SECONDS;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(scope, id, issuedAt, expiresAt));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return ['v1', id, issuedAt, expiresAt, iv.toString('base64'),
    cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptQueueCredential(
  keysValue: string | undefined,
  value: string,
  scope: QueueCredentialScope,
  now = new Date(),
): string {
  try {
    if (typeof value !== 'string' || value.length > MAX_ENVELOPE_CHARACTERS) throw invalidCredential();
    const fields = value.split('.');
    if (fields.length !== 7) throw invalidCredential();
    const [version, id, issued, expires, iv, tag, ciphertext] = fields;
    if (version !== 'v1' || !id || !issued || !expires || !iv || !tag || !ciphertext
      || !/^(0|[1-9][0-9]{0,12})$/.test(issued) || !/^(0|[1-9][0-9]{0,12})$/.test(expires)) throw invalidCredential();
    const issuedAt = Number(issued);
    const expiresAt = Number(expires);
    const current = epochSeconds(now);
    if (expiresAt - issuedAt !== QUEUE_CREDENTIAL_TTL_SECONDS
      || issuedAt > current + CLOCK_SKEW_SECONDS || current >= expiresAt) throw invalidCredential();
    const key = parseQueueEncryptionKeys(keysValue).get(id);
    if (!key) throw invalidCredential();
    const encrypted = decodeCanonical(ciphertext);
    if (encrypted.length > MAX_CREDENTIAL_BYTES) throw invalidCredential();
    const decipher = createDecipheriv('aes-256-gcm', key, decodeCanonical(iv, 12), { authTagLength: 16 });
    decipher.setAAD(aad(scope, id, issuedAt, expiresAt));
    decipher.setAuthTag(decodeCanonical(tag, 16));
    const bytes = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const result = bytes.toString('utf8');
    if (!result.trim() || !Buffer.from(result, 'utf8').equals(bytes)) throw invalidCredential();
    return result;
  } catch {
    // Never retain a crypto/parser cause that could expose credential material.
    throw invalidCredential();
  }
}
