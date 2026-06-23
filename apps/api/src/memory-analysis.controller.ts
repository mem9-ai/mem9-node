import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from './common/api-key.guard';
import { RateLimitGuard } from './common/rate-limit.guard';
import { CurrentContext } from './common/request-context';
import type { Mem9RequestContext } from './common/request-context';
import { AnalyzeMemorySourceDto } from './dto/analyze-memory-source.dto';
import { MemoryAnalysisService } from './memory-analysis.service';

@ApiTags('memory-analysis')
@ApiHeader({
  name: 'x-mem9-api-key',
  required: true,
  description: 'MEM9 API key forwarded by the browser; this service stores only its fingerprint.',
})
@Controller('v1/memory-analysis')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class MemoryAnalysisController {
  public constructor(private readonly service: MemoryAnalysisService) {}

  @Post('analyze-source')
  @ApiOperation({ summary: 'Analyze source memories and build local change groups' })
  public analyzeSource(
    @CurrentContext() context: Mem9RequestContext,
    @Body() dto: AnalyzeMemorySourceDto,
  ) {
    return this.service.analyzeSource(context.rawApiKey, dto);
  }
}
