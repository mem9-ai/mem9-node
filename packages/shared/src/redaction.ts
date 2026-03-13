export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...headers };

  if ('x-mem9-api-key' in clone) {
    clone['x-mem9-api-key'] = '[REDACTED]';
  }

  if ('authorization' in clone) {
    clone.authorization = '[REDACTED]';
  }

  return clone;
}
