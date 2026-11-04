export interface QueueCredentialKeyring {
  activeKid: string;
  keys: Map<string, Buffer>;
}

const KID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(): Error {
  return new Error('Invalid QUEUE_CREDENTIAL_KEYRING configuration');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseQueueCredentialKeyring(
  value: string | undefined,
): QueueCredentialKeyring {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw invalid();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid();
  }

  if (!isRecord(parsed)) {
    throw invalid();
  }

  if (Object.keys(parsed).length !== 2
    || !Object.hasOwn(parsed, 'encryption_kid')
    || !Object.hasOwn(parsed, 'encryption_keys')) {
    throw invalid();
  }

  const activeKid = parsed.encryption_kid;
  const encryptionKeys = parsed.encryption_keys;
  if (typeof activeKid !== 'string' || !KID_PATTERN.test(activeKid)
    || !isRecord(encryptionKeys)) {
    throw invalid();
  }

  const entries = Object.entries(encryptionKeys);
  if (entries.length === 0 || entries.length > 8) {
    throw invalid();
  }

  const parsedKeys = new Map<string, Buffer>();
  const seenKeyBytes = new Set<string>();
  for (const [kid, encodedKey] of entries) {
    if (!KID_PATTERN.test(kid) || typeof encodedKey !== 'string') {
      throw invalid();
    }

    let key: Buffer;
    try {
      key = Buffer.from(encodedKey, 'base64');
    } catch {
      throw invalid();
    }

    if (key.length !== 32 || key.toString('base64') !== encodedKey) {
      throw invalid();
    }

    const keyIdentity = key.toString('base64');
    if (seenKeyBytes.has(keyIdentity)) {
      throw invalid();
    }
    seenKeyBytes.add(keyIdentity);
    parsedKeys.set(kid, key);
  }

  if (!parsedKeys.has(activeKid)) {
    throw invalid();
  }

  return { activeKid, keys: parsedKeys };
}
