import { loadConfig } from '@mem9/config';
import * as Sentry from '@sentry/nestjs';

const config = loadConfig();

if (config.sentry.dsn !== undefined) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.app.env,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        process: 'worker',
      },
    },
  });
}
