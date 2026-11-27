import type { ErrorEvent, EventHint } from '@sentry/nestjs';

import { scrubSentryEvent, sentryPrivacyOptions } from './sentry-privacy';

it('removes payloads, credentials and attachments while retaining diagnostic identifiers and code locations', () => {
  const secret = 'tenant-secret-123';
  const event: ErrorEvent = {
    type: undefined, event_id: 'event1', release: 'release1', environment: 'production', level: 'error',
    message: secret, logentry: { message: secret },
    user: { email: secret },
    request: { url: `https://user:${secret}@example.com/${secret}?key=${secret}`,
      headers: { Authorization: secret, Cookie: secret, 'X-API-Key': secret }, data: secret },
    extra: { nested: { memory: secret } }, contexts: { custom: { secret } },
    breadcrumbs: [{ message: secret, data: { secret } }],
    tags: { process: 'worker', requestId: 'req_123', tenant: secret },
    fingerprint: [secret],
    exception: { values: [{ type: 'TypeError', value: secret, stacktrace: { frames: [{
      filename: `/app/main.js?key=${secret}`, function: 'processBatch', lineno: 42, colno: 3,
      vars: { secret }, context_line: secret, pre_context: [secret], post_context: [secret],
    }] } }] },
  };
  const hint: EventHint = {
    originalException: Object.assign(new Error(secret), { code: 'BATCH_PROCESSING_FAILED' }),
    attachments: [{ filename: 'dump.txt', data: secret }],
  };
  const result = scrubSentryEvent(event, hint);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(hint.attachments).toEqual([]);
  expect(result).toMatchObject({ event_id: 'event1', release: 'release1', environment: 'production',
    tags: { process: 'worker', requestId: 'req_123', errorCode: 'BATCH_PROCESSING_FAILED' },
    exception: { values: [{ type: 'TypeError', value: 'Internal application error',
      stacktrace: { frames: [{ filename: '/app/main.js', function: 'processBatch', lineno: 42 }] } }] },
  });
  expect(event.message).toBe(secret);
});

it('drops unstructured messages even when an event has no exception', () => {
  expect(scrubSentryEvent({ type: undefined, message: 'private memory', tags: { process: 'unknown' } }, {}))
    .toMatchObject({ tags: {}, exception: { values: [] } });
});

it('disables breadcrumbs, tracing and logs as alternate payload channels', () => {
  expect(sentryPrivacyOptions.beforeBreadcrumb()).toBeNull();
  expect(sentryPrivacyOptions.beforeSendTransaction()).toBeNull();
  expect(sentryPrivacyOptions.beforeSendLog()).toBeNull();
  expect(sentryPrivacyOptions.enableLogs).toBe(false);
  expect(sentryPrivacyOptions.tracesSampleRate).toBe(0);
});
