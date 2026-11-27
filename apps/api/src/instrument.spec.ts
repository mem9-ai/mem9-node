import type * as ConfigModule from '@mem9/config';
import { sentryPrivacyOptions } from '@mem9/config';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({ init: jest.fn() }));
jest.mock('@mem9/config', () => ({
  ...jest.requireActual<typeof ConfigModule>('@mem9/config'),
  loadConfig: () => ({ app: { env: 'test' }, sentry: { dsn: 'https://example.invalid/1' } }),
}));

it('installs the privacy boundary in both API and worker instrumentation', async () => {
  await import('./instrument');
  await import('../../worker/src/instrument');
  expect(Sentry.init).toHaveBeenCalledTimes(2);
  for (const process of ['api', 'worker']) {
    expect(Sentry.init).toHaveBeenCalledWith({
      dsn: 'https://example.invalid/1', environment: 'test', ...sentryPrivacyOptions,
      initialScope: { tags: { process } },
    });
  }
});
