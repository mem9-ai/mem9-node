import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const MEMORY_ANALYSIS_REPORT_TYPES = [
  'focus_area',
  'long_term_goal',
  'emotion',
] as const;

export type MemoryAnalysisReportType = typeof MEMORY_ANALYSIS_REPORT_TYPES[number];

export class ListMemoryAnalysisReportsDto {
  @ApiProperty({
    enum: MEMORY_ANALYSIS_REPORT_TYPES,
    description: 'Report type: focus_area=关注点变化, long_term_goal=长期目标变化, emotion=情绪变化',
  })
  @IsIn(MEMORY_ANALYSIS_REPORT_TYPES)
  public type!: MemoryAnalysisReportType;
}
