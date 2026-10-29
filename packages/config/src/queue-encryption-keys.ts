/** The first independent key encrypts; retained keys support overlapping rotation. */
export function parseQueueEncryptionKeys(value: string | undefined): Map<string, Buffer> {
  const invalid = (): never => {
    throw new Error('Invalid QUEUE_ENCRYPTION_KEYS configuration');
  };
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return invalid();
  const entries = value.split(',');
  if (entries.length > 8) return invalid();
  const keys = new Map<string, Buffer>();
  for (const entry of entries) {
    const fields = entry.split(':');
    if (fields.length !== 2) return invalid();
    const [id, encoded] = fields;
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !encoded || keys.has(id)) return invalid();
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) return invalid();
    keys.set(id, key);
  }
  return keys;
}
