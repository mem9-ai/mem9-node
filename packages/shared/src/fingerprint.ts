import { createHmac, timingSafeEqual } from 'node:crypto';

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
