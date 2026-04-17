import { createServer, type Server } from 'node:http';

import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';

import { DeepAnalysisMetricsService } from './deep-analysis-metrics.service';

@Injectable()
export class WorkerHealthServer implements OnModuleDestroy {
  private server?: Server;

  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly deepAnalysisMetrics: DeepAnalysisMetricsService,
  ) {}

  public start(): void {
    this.server = createServer((request, response) => {
      if (request.url === '/health/live' || request.url === '/health/ready') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (request.url === '/metrics') {
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        });
        response.end(this.deepAnalysisMetrics.renderPrometheusMetrics());
        return;
      }

      response.writeHead(404);
      response.end();
    });

    this.server.listen(this.config.app.workerHealthPort, '0.0.0.0');
  }

  public async onModuleDestroy(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }
}
