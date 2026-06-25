import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateMemoryAnalysisReportDto {
  @ApiProperty()
  @IsString()
  public template_id!: string;

  @ApiProperty()
  @IsString()
  public report_content!: string;

  @ApiProperty({ enum: ['fail', 'success'] })
  @IsIn(['fail', 'success'])
  public render_status!: 'fail' | 'success';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  public fail_reason?: string;
}
