import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateMemoryAnalysisReportDto {
  @ApiProperty({ example: 'focus_area' })
  @IsString()
  public template_id!: string;

  @ApiProperty({ example: '{"summary":"focus changed"}' })
  @IsString()
  public report_content!: string;

  @ApiProperty({ example: '2026-06-01T00:00:00.000Z' })
  @IsDateString()
  public startTime!: string;

  @ApiProperty({ example: '2026-06-14T23:59:59.999Z' })
  @IsDateString()
  public endTime!: string;

  @ApiProperty({ enum: ['fail', 'success'] })
  @IsIn(['fail', 'success'])
  public render_status!: 'fail' | 'success';

  @ApiPropertyOptional({ example: '' })
  @IsOptional()
  @IsString()
  public fail_reason?: string;

  @ApiProperty({ example: 42 })
  @IsInt()
  @Min(0)
  public memory_count!: number;
}
