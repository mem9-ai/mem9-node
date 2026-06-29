import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MemoryAnalysisReportResponseDto {
  @ApiProperty({ example: 123 })
  public report_id!: number;

  @ApiProperty({ example: 'memory_analysis' })
  public template_id!: string;

  @ApiPropertyOptional({ example: '{"total":9,"memoryCount":9,"dimensions":[]}', nullable: true })
  public report_content!: string | null;

  @ApiProperty({ example: '2026-06-29T02:45:00.000Z' })
  public generated_at!: string;

  @ApiPropertyOptional({ example: '2026-06-29T02:45:01.000Z', nullable: true })
  public started_at!: string | null;

  @ApiPropertyOptional({ example: '2026-06-29T02:45:12.000Z', nullable: true })
  public completed_at!: string | null;

  @ApiPropertyOptional({ example: '2026-06-22T00:00:00.000Z', nullable: true })
  public startTime!: string | null;

  @ApiPropertyOptional({ example: '2026-06-22T23:59:59.999Z', nullable: true })
  public endTime!: string | null;

  @ApiProperty({ enum: ['queued', 'running', 'success', 'fail'] })
  public render_status!: 'queued' | 'running' | 'success' | 'fail';

  @ApiProperty({ enum: ['queued', 'fetch_source', 'period_summary', 'aggregation', 'save_result', 'complete', 'failed'] })
  public report_stage!: 'queued' | 'fetch_source' | 'period_summary' | 'aggregation' | 'save_result' | 'complete' | 'failed';

  @ApiPropertyOptional({ example: 'MEMORY_ANALYSIS_GENERATION_FAILED', nullable: true })
  public fail_code!: string | null;

  @ApiPropertyOptional({ example: 'Memory analysis generation failed. Please retry later.', nullable: true })
  public fail_reason!: string | null;

  @ApiProperty({ example: 9 })
  public memory_count!: number;
}
