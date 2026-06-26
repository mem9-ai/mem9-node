import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from '../common/api-key.guard';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { CurrentContext } from '../common/request-context';
import type { Mem9RequestContext } from '../common/request-context';
import { AnalyzeMemorySourceDto } from '../dto/analyze-memory-source.dto';
import { CreateMemoryAnalysisReportDto } from '../dto/create-memory-analysis-report.dto';
import { ListMemoryAnalysisReportsDto } from '../dto/list-memory-analysis-reports.dto';

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
    @Query() query: AnalyzeMemorySourceDto,
  ) {
    return this.service.analyzeSource(context, query);
  }

  @Post('report')
  @ApiOperation({ summary: 'Create a memory analysis report' })
  public createReport(
    @CurrentContext() context: Mem9RequestContext,
    @Body() dto: CreateMemoryAnalysisReportDto,
  ) {
    return this.service.createReport(context, dto);
  }

  @Get('report/list')
  @ApiOperation({ summary: 'List memory analysis reports by type' })
  public listReports(
    @CurrentContext() context: Mem9RequestContext,
    @Query() query: ListMemoryAnalysisReportsDto,
  ) {
    return this.service.listReports(context, query);
  }

  @Get('report/:report_id')
  @ApiOperation({ summary: 'Get one memory analysis report' })
  public getReport(
    @CurrentContext() context: Mem9RequestContext,
    @Param('report_id') reportId: string,
  ) {
    return this.service.getReport(context, reportId);
  }
}
