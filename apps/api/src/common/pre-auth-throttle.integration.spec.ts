import { APP_CONFIG, loadApiIngressConfig } from '@mem9/config';
import { deriveApiKeyFingerprint } from '@mem9/shared';
import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { ApiKeyAuthService } from './api-key-auth.service';
import { ApiKeyGuard } from './api-key.guard';
import { installPreAuthThrottle } from './pre-auth-throttle';

@Controller('v1/protected')
@UseGuards(ApiKeyGuard)
class ProtectedController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('pre-authentication integration with Nest guards', () => {
  it('keeps admitted identity unchanged and stops the next key before the real auth guard', async () => {
    const pepper = 'unchanged-test-pepper-1234567890';
    const authenticate = jest
      .fn()
      .mockResolvedValue({
        id: 'subject',
        status: 'ACTIVE',
        planCode: 'default',
      });
    const module = await Test.createTestingModule({
      controllers: [ProtectedController],
      providers: [
        ApiKeyGuard,
        { provide: ApiKeyAuthService, useValue: { authenticate } },
        { provide: APP_CONFIG, useValue: { app: { pepper } } },
      ],
    }).compile();
    const adapter = new FastifyAdapter();
    installPreAuthThrottle(
      adapter.getInstance(),
      { ...loadApiIngressConfig({}), ipBurst: 1 },
      () => 0,
    );
    const app = module.createNestApplication<NestFastifyApplication>(adapter);
    try {
      await app.init();
      const first = await app.inject({
        url: '/v1/protected',
        headers: { 'x-mem9-api-key': 'existing-key' },
      });
      expect(first.statusCode).toBe(200);
      expect(authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          rawApiKey: 'existing-key',
          fingerprint: deriveApiKeyFingerprint(pepper, 'existing-key'),
        }),
      );
      const second = await app.inject({
        url: '/v1/protected',
        headers: { 'x-mem9-api-key': 'rotated-forged-key' },
      });
      expect(second.statusCode).toBe(429);
      expect(authenticate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
