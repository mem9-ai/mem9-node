import { deriveApiKeyFingerprint, safeFingerprintEquals } from './fingerprint';

describe('fingerprint', () => {
  it('derives a stable 32-byte fingerprint', () => {
    const fingerprint = deriveApiKeyFingerprint('pepper-1234567890123456', 'secret-api-key');

    expect(fingerprint).toHaveLength(32);
    expect(fingerprint.equals(deriveApiKeyFingerprint('pepper-1234567890123456', 'secret-api-key'))).toBe(true);
  });

  it('compares fingerprints safely', () => {
    const left = deriveApiKeyFingerprint('pepper-1234567890123456', 'a');
    const right = deriveApiKeyFingerprint('pepper-1234567890123456', 'a');
    const mismatch = deriveApiKeyFingerprint('pepper-1234567890123456', 'b');

    expect(safeFingerprintEquals(left, right)).toBe(true);
    expect(safeFingerprintEquals(left, mismatch)).toBe(false);
  });
});
