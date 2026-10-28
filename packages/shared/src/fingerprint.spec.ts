import { deriveApiKeyFingerprint, parseApiKeyFingerprint, safeFingerprintEquals } from './fingerprint';

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

  it('accepts a complete canonical owner fingerprint', () => {
    const fingerprint = deriveApiKeyFingerprint('pepper-1234567890123456', 'space-key');
    expect(parseApiKeyFingerprint(fingerprint.toString('hex'))).toEqual(fingerprint);
  });

  it.each([
    undefined, null, 12, {}, [], '', 'ab', 'ab'.repeat(31), 'ab'.repeat(33),
    'AB'.repeat(32), `${'ab'.repeat(32)}zz`, `${'ab'.repeat(32)}\n`,
    `${'ab'.repeat(31)}xx`,
  ])('rejects invalid owners without accepting a truncated hex prefix: %p', (value) => {
    expect(() => parseApiKeyFingerprint(value)).toThrow('Invalid queue owner fingerprint');
  });
});
