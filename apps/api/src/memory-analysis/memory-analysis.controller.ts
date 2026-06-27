import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type {
  DeleteSessionMessageEditResponse,
  EditSessionMessageResponse,
  GetSessionMessageEditResponse,
  MarkSessionMessageResponse,
} from '@mem9/contracts';

import { ApiKeyGuard } from '../common/api-key.guard';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { CurrentContext } from '../common/request-context';
import type { Mem9RequestContext } from '../common/request-context';
import { AnalyzeMemorySourceDto } from '../dto/analyze-memory-source.dto';
import { CreateMemoryAnalysisReportDto } from '../dto/create-memory-analysis-report.dto';
import { EditSessionMessageDto } from '../dto/edit-session-message.dto';
import { ListMemoryAnalysisReportsDto } from '../dto/list-memory-analysis-reports.dto';
import { MarkSessionMessageDto } from '../dto/mark-session-message.dto';
import {
  ApiErrorResponseDto,
  DeleteSessionMessageEditResponseDto,
  EditSessionMessageResponseDto,
  MarkSessionMessageResponseDto,
  SessionMessageEditResponseDto,
} from '../dto/session-message-response.dto';

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

  @Put('session-messages/:id/mark')
  @ApiOperation({ summary: 'Mark a source session message as correct or incorrect' })
  @ApiOkResponse({
    description: 'Session message correctness mark was updated.',
    type: MarkSessionMessageResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid correctness value.',
    type: ApiErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid MEM9 API key.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Session message was not found upstream.',
    type: ApiErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'Failed to call the upstream mem9 session message API.',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit exceeded.',
    type: ApiErrorResponseDto,
  })
  public markSessionMessage(
    @CurrentContext() context: Mem9RequestContext,
    @Param('id') id: string,
    @Body() dto: MarkSessionMessageDto,
  ): Promise<MarkSessionMessageResponse> {
    return this.service.markSessionMessage(context, id, dto.correctness);
  }

  @Put('session-messages/:id/edit')
  @ApiOperation({ summary: 'Correct a source session message and invalidate its analysis cache' })
  @ApiOkResponse({
    description: 'Session message correction overlay was upserted and the affected day cache was invalidated.',
    type: EditSessionMessageResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid edit payload or empty content.',
    type: ApiErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid MEM9 API key.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Session message was not found upstream.',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Session message edit conflict.',
    type: ApiErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'Failed to call the upstream mem9 session message API.',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit exceeded.',
    type: ApiErrorResponseDto,
  })
  public editSessionMessage(
    @CurrentContext() context: Mem9RequestContext,
    @Param('id') id: string,
    @Body() dto: EditSessionMessageDto,
  ): Promise<EditSessionMessageResponse> {
    return this.service.editSessionMessage(context, id, dto);
  }

  @Get('session-messages/:id/edit')
  @ApiOperation({ summary: 'Get the current correction overlay for a source session message' })
  @ApiOkResponse({
    description: 'Current session message correction overlay.',
    type: SessionMessageEditResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid MEM9 API key.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Session message edit overlay was not found upstream.',
    type: ApiErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'Failed to call the upstream mem9 session message API.',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit exceeded.',
    type: ApiErrorResponseDto,
  })
  public getSessionMessageEdit(
    @CurrentContext() context: Mem9RequestContext,
    @Param('id') id: string,
  ): Promise<GetSessionMessageEditResponse> {
    return this.service.getSessionMessageEdit(context, id);
  }

  @Delete('session-messages/:id/edit')
  @ApiOperation({ summary: 'Revert a source session message correction and invalidate its analysis cache' })
  @ApiOkResponse({
    description: 'Session message correction overlay was removed and the affected day cache was invalidated.',
    type: DeleteSessionMessageEditResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid MEM9 API key.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Session message was not found upstream.',
    type: ApiErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'Failed to call the upstream mem9 session message API.',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit exceeded.',
    type: ApiErrorResponseDto,
  })
  public deleteSessionMessageEdit(
    @CurrentContext() context: Mem9RequestContext,
    @Param('id') id: string,
  ): Promise<DeleteSessionMessageEditResponse> {
    return this.service.deleteSessionMessageEdit(context, id);
  }
}
