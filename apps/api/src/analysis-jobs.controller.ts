import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AnalysisJobsService } from './analysis-jobs.service';
import { ApiKeyGuard } from './common/api-key.guard';
import { RateLimitGuard } from './common/rate-limit.guard';
import { CurrentContext } from './common/request-context';
import type { Mem9RequestContext } from './common/request-context';
import { CreateAnalysisJobDto } from './dto/create-analysis-job.dto';
import { UpdatesQueryDto } from './dto/updates-query.dto';
import { UploadAnalysisBatchDto } from './dto/upload-analysis-batch.dto';

@ApiTags('analysis-jobs')
@ApiHeader({
  name: 'x-mem9-api-key',
  required: true,
  description: 'MEM9 API key forwarded by the browser; this service stores only its fingerprint.',
})
@Controller('v1')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class AnalysisJobsController {
  public constructor(private readonly service: AnalysisJobsService) {}

  @Post('analysis-jobs')
  @ApiOperation({ summary: 'Create a new long-running memories analysis job' })
  public createJob(@CurrentContext() context: Mem9RequestContext, @Body() dto: CreateAnalysisJobDto) {
    return this.service.createJob(context, dto);
  }

  @Put('analysis-jobs/:jobId/batches/:batchIndex')
  @ApiOperation({ summary: 'Upload one memories batch and enqueue it for processing' })
  public uploadBatch(
    @CurrentContext() context: Mem9RequestContext,
    @Param('jobId') jobId: string,
    @Param('batchIndex', ParseIntPipe) batchIndex: number,
    @Body() dto: UploadAnalysisBatchDto,
  ) {
    return this.service.uploadBatch(context, jobId, batchIndex, dto);
  }

  @Post('analysis-jobs/:jobId/finalize')
  @ApiOperation({ summary: 'Signal that batch uploads are complete for a job' })
  public finalizeJob(@CurrentContext() context: Mem9RequestContext, @Param('jobId') jobId: string) {
    return this.service.finalizeJob(context, jobId);
  }

  @Post('analysis-jobs/:jobId/cancel')
  @ApiOperation({ summary: 'Cancel an in-flight analysis job' })
  public cancelJob(@CurrentContext() context: Mem9RequestContext, @Param('jobId') jobId: string) {
    return this.service.cancelJob(context, jobId);
  }

  @Get('analysis-jobs/:jobId')
  @ApiOperation({ summary: 'Get the current job snapshot including partial aggregate results' })
  public getSnapshot(@CurrentContext() context: Mem9RequestContext, @Param('jobId') jobId: string) {
    return this.service.getSnapshot(context, jobId);
  }

  @Get('analysis-jobs/:jobId/updates')
  @ApiOperation({ summary: 'Get incremental updates newer than the provided cursor' })
  public getUpdates(
    @CurrentContext() context: Mem9RequestContext,
    @Param('jobId') jobId: string,
    @Query() query: UpdatesQueryDto,
  ) {
    return this.service.getUpdates(context, jobId, query.cursor);
  }

  @Get('taxonomy')
  @ApiOperation({ summary: 'Get the active taxonomy and rule set' })
  public getTaxonomy(@Query('version') version?: string) {
    return this.service.getTaxonomy(version);
  }
}
