import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class ListMemoryAnalysisReportsDto {
  @ApiProperty({ enum: ['focus_area', 'long_term_goal', 'preference_signal', 'growth_signal'] })
  @IsIn(['focus_area', 'long_term_goal', 'preference_signal', 'growth_signal'])
  public type!: 'focus_area' | 'long_term_goal' | 'preference_signal' | 'growth_signal';
}
