import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError } from './errors';

export function deriveApiKeyFingerprint(pepper: string, apiKey: string): Buffer {
  return createHmac('sha256', pepper).update(apiKey, 'utf8').digest();
}

export function fingerprintToHex(fingerprint: Buffer): string {
  return fingerprint.toString('hex');
}

export function safeFingerprintEquals(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function parseApiKeyFingerprint(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AppError('Invalid queue owner fingerprint', {
      statusCode: 403,
      code: 'INVALID_QUEUE_OWNER',
    });
  }

  return Buffer.from(value, 'hex');
}
