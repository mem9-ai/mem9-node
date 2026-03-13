import { PrismaService, RedisService } from '@mem9/shared';
import { Injectable } from '@nestjs/common';


@Injectable()
export class HealthService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  public async getLiveness(): Promise<{ status: 'ok' }> {
    return { status: 'ok' };
  }

  public async getReadiness(): Promise<{ status: 'ready' }> {
    await this.prisma.$queryRawUnsafe('SELECT 1');
    await this.redis.ping();

    return { status: 'ready' };
  }
}
