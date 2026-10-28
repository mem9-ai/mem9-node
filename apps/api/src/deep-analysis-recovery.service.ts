import { AnalysisRepository } from '@mem9/shared';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

@Injectable()
export class DeepAnalysisRecoveryService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DeepAnalysisRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(private readonly repository: AnalysisRepository) {}

  public onApplicationBootstrap(): void {
    const recover = () => {
      void this.runOnce().catch(() => {
        this.logger.error(
          JSON.stringify({ event: 'deep_analysis_recovery_failed' }),
        );
      });
    };
    recover();
    this.timer = setInterval(recover, 60 * 1000);
    this.timer.unref();
  }

  public onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async runOnce(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const count = await this.repository.expireStaleDeepAnalysisReports(now);
      if (count > 0) {
        this.logger.warn(
          JSON.stringify({
            event: 'deep_analysis_abandoned_reports_failed',
            count,
          }),
        );
      }
      return count;
    } finally {
      this.running = false;
    }
  }
}
