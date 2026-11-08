import { performance } from 'node:perf_hooks';

import { PrismaService, RedisService } from '@mem9/shared';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class HealthService {
  private cached?: { healthy: boolean; expiresAt: number };
  private probe?: Promise<boolean>;
  private response?: Promise<{ status: 'ready' }>;
  public constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  public async getLiveness(): Promise<{ status: 'ok' }> {
    return { status: 'ok' };
  }

  public async getReadiness(): Promise<{ status: 'ready' }> {
    if (this.cached && performance.now() < this.cached.expiresAt) {
      return this.readinessResult(this.cached.healthy);
    }
    if (this.response) return this.response;

    // Keep a timed-out database operation in flight until it actually settles.
    // Otherwise repeated probes could accumulate unbounded hanging queries.
    this.probe ??= this.checkDependencies().finally(() => {
      this.probe = undefined;
    });
    this.response = this.waitForProbe(this.probe)
      .then((healthy) => {
        // Cache failures too: an outage must not trigger one query per request.
        this.cached = { healthy, expiresAt: performance.now() + 1000 };
        return this.readinessResult(healthy);
      })
      .finally(() => {
        this.response = undefined;
      });
    return this.response;
  }

  private readinessResult(healthy: boolean): { status: 'ready' } {
    if (!healthy)
      throw new ServiceUnavailableException('Dependencies are not ready');
    return { status: 'ready' };
  }

  private async checkDependencies(): Promise<boolean> {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async waitForProbe(probe: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        probe,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
