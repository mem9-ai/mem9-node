import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateMemoryAnalysisReportDto {
  @ApiProperty({ example: 'focus_area' })
  @IsString()
  public template_id!: string;

  @ApiProperty({ example: '{"summary":"focus changed"}' })
  @IsString()
  public report_content!: string;

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
