import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class CreateMemoryAnalysisReportDto {
  @ApiProperty({ example: '2026-06-22T00:00:00.000Z' })
  @IsDateString()
  public createdAfter!: string;

  @ApiProperty({ example: '2026-06-22T23:59:59.999Z' })
  @IsDateString()
  public createdBefore!: string;
}
