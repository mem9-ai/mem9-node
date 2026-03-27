import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { DeepAnalysisService } from './deep-analysis.service';
import { ApiKeyGuard } from './common/api-key.guard';
import { CurrentContext } from './common/request-context';
import type { Mem9RequestContext } from './common/request-context';
import { RateLimitGuard } from './common/rate-limit.guard';
import { CreateDeepAnalysisReportDto } from './dto/create-deep-analysis-report.dto';
import { ListDeepAnalysisReportsDto } from './dto/list-deep-analysis-reports.dto';

@ApiTags('deep-analysis')
@ApiHeader({
  name: 'x-mem9-api-key',
  required: true,
  description: 'MEM9 API key forwarded by the browser; this service stores only its fingerprint.',
})
@Controller('v1/deep-analysis')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class DeepAnalysisController {
  public constructor(private readonly service: DeepAnalysisService) {}

  @Post('reports')
  @HttpCode(202)
  @ApiOperation({ summary: 'Create a new deep analysis report' })
  public createReport(
    @CurrentContext() context: Mem9RequestContext,
    @Body() dto: CreateDeepAnalysisReportDto,
  ) {
    return this.service.createReport(context, dto);
  }

  @Get('reports')
  @ApiOperation({ summary: 'List deep analysis reports' })
  public listReports(
    @CurrentContext() context: Mem9RequestContext,
    @Query() query: ListDeepAnalysisReportsDto,
  ) {
    return this.service.listReports(context, query);
  }

  @Get('reports/:reportId')
  @ApiOperation({ summary: 'Get one deep analysis report detail' })
  public getReport(
    @CurrentContext() context: Mem9RequestContext,
    @Param('reportId') reportId: string,
  ) {
    return this.service.getReport(context, reportId);
  }
}
