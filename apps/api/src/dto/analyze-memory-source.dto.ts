import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class AnalyzeMemorySourceDto {
  @ApiProperty({ example: '2026-06-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  public createdAfter!: string;

  @ApiProperty({ example: '2026-06-30T23:59:59Z' })
  @IsOptional()
  @IsString()
  public createdBefore!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  public debugFirstPass = false;
}
