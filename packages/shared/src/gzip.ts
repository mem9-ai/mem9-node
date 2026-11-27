import { promisify } from 'node:util';
import { gunzip, gzipSync } from 'node:zlib';

import { AppError } from './errors';

export const MAX_SNAPSHOT_STORED_BYTES = 32 * 1024 * 1024;
export const MAX_SNAPSHOT_JSON_BYTES = 64 * 1024 * 1024;
const decompress = promisify(gunzip);

export function assertSnapshotSize(size: number, limit: number): void {
  if (size > limit) {
    throw new AppError('Analysis snapshot exceeds the supported size limit', {
      code: 'PAYLOAD_TOO_LARGE', statusCode: 413,
    });
  }
}

export function gzipJson(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value));
  assertSnapshotSize(json.length, MAX_SNAPSHOT_JSON_BYTES);
  const compressed = gzipSync(json);
  assertSnapshotSize(compressed.length, MAX_SNAPSHOT_STORED_BYTES);
  return compressed;
}

export async function gunzipJson<T>(
  value: Buffer,
  maxOutputBytes = MAX_SNAPSHOT_JSON_BYTES,
): Promise<T> {
  assertSnapshotSize(value.length, MAX_SNAPSHOT_STORED_BYTES);
  let json: Buffer;
  try {
    json = await decompress(value, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      assertSnapshotSize(maxOutputBytes + 1, maxOutputBytes);
    }
    throw error;
  }
  return JSON.parse(json.toString('utf8')) as T;
}
