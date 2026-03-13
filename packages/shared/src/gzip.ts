import { gunzipSync, gzipSync } from 'node:zlib';

export function gzipJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value)));
}

export function gunzipJson<T>(value: Buffer): T {
  return JSON.parse(gunzipSync(value).toString('utf8')) as T;
}
