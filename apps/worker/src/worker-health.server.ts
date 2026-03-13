import { createServer, type Server } from 'node:http';


import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class WorkerHealthServer implements OnModuleDestroy {
  private server?: Server;

  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  public start(): void {
    this.server = createServer((request, response) => {
      if (request.url === '/health/live' || request.url === '/health/ready') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
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
