import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { HealthService } from './common/health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  public constructor(private readonly healthService: HealthService) {}

  @Get('live')
  public getLiveness() {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  public getReadiness() {
    return this.healthService.getReadiness();
  }
}
