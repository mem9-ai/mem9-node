
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import { Inject, Injectable } from '@nestjs/common';

export interface GoVerifyResult {
  status: 'ACTIVE' | 'DISABLED';
  planCode: string;
  verifiedAt: Date;
}

@Injectable()
export class GoVerifyService {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  public async verify(): Promise<GoVerifyResult> {
    if (this.config.goVerify.mode === 'noop') {
      return {
        status: 'ACTIVE',
        planCode: 'default',
        verifiedAt: new Date(),
      };
    }

    return {
      status: 'ACTIVE',
      planCode: 'default',
      verifiedAt: new Date(),
    };
  }
}
