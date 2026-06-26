import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class ListMemoryAnalysisReportsDto {
  @ApiProperty({ enum: ['focus_area', 'long_term_goal', 'emotion'] })
  @IsIn(['focus_area', 'long_term_goal', 'emotion'])
  public type!: 'focus_area' | 'long_term_goal' | 'emotion';
}
