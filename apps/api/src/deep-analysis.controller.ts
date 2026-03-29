import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

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

  @Get('reports/:reportId/duplicates.csv')
  @ApiOperation({ summary: 'Download duplicate cleanup CSV for one deep analysis report' })
  public async downloadDuplicateCleanupCsv(
    @CurrentContext() context: Mem9RequestContext,
    @Param('reportId') reportId: string,
    @Res() reply: FastifyReply,
  ) {
    const { filename, content } = await this.service.downloadDuplicateCleanupCsv(context, reportId);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(content);
  }

  @Post('reports/:reportId/delete-duplicates')
  @HttpCode(202)
  @ApiOperation({ summary: 'Delete duplicate memories for one deep analysis report' })
  public deleteDuplicateMemories(
    @CurrentContext() context: Mem9RequestContext,
    @Param('reportId') reportId: string,
  ) {
    return this.service.deleteDuplicateMemories(context, reportId);
  }

  @Delete('reports/:reportId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete one deep analysis report' })
  public deleteReport(
    @CurrentContext() context: Mem9RequestContext,
    @Param('reportId') reportId: string,
  ) {
    return this.service.deleteReport(context, reportId);
  }
}
