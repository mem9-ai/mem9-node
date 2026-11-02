import { randomUUID } from 'node:crypto';

export function resolveRequestId(value: unknown): string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    !/[^A-Za-z0-9._:-]/.test(value)
    ? value
    : randomUUID();
}
