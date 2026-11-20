import { isIP } from 'node:net';

import { z } from 'zod';

const cidr = z.string().refine((value) => {
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address ?? '');
  return (
    family !== 0 &&
    extra === undefined &&
    (prefix === undefined ||
      (/^\d+$/u.test(prefix) &&
        Number(prefix) <= (family === 4 ? 32 : 128) &&
        Number(prefix) > 0))
  );
}, 'Expected a proxy IP or CIDR with a non-zero prefix');

const schema = z.object({
  PREAUTH_TRUSTED_PROXY_CIDRS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(cidr)),
  PREAUTH_IP_REQUESTS_PER_SECOND: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20),
  PREAUTH_IP_BURST: z.coerce.number().int().min(1).max(10000).default(100),
  PREAUTH_TOTAL_REQUESTS_PER_SECOND: z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(100),
  PREAUTH_TOTAL_BURST: z.coerce.number().int().min(1).max(10000).default(300),
});

// API-only configuration, deliberately independent of Redis and tenant identity.
export function loadApiIngressConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const env = schema.parse(environment);
  return {
    trustedProxyCidrs: env.PREAUTH_TRUSTED_PROXY_CIDRS,
    ipRequestsPerSecond: env.PREAUTH_IP_REQUESTS_PER_SECOND,
    ipBurst: env.PREAUTH_IP_BURST,
    totalRequestsPerSecond: env.PREAUTH_TOTAL_REQUESTS_PER_SECOND,
    totalBurst: env.PREAUTH_TOTAL_BURST,
  };
}

export type ApiIngressConfig = ReturnType<typeof loadApiIngressConfig>;
