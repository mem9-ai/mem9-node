import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';


@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super(config.redis.url, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
  }

  public async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
