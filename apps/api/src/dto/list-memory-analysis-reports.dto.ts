import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class ListMemoryAnalysisReportsDto {
  @ApiProperty({
    enum: ['memory_analysis', 'focus_area', 'long_term_goal', 'emotion', 'preference_signal', 'growth_signal'],
    required: false,
  })
  @IsOptional()
  @IsIn(['memory_analysis', 'focus_area', 'long_term_goal', 'emotion', 'preference_signal', 'growth_signal'])
  public type?: 'memory_analysis' | 'focus_area' | 'long_term_goal' | 'emotion' | 'preference_signal' | 'growth_signal';
}
