import { randomUUID } from 'node:crypto';

export function createPrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}
