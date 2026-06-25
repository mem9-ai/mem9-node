import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const DEFAULT_MEMORY_ANALYSIS_LIMIT = 100;
const MAX_MEMORY_ANALYSIS_LIMIT = 200;

export class AnalyzeMemorySourceDto {
  @ApiPropertyOptional({ default: DEFAULT_MEMORY_ANALYSIS_LIMIT, maximum: MAX_MEMORY_ANALYSIS_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MEMORY_ANALYSIS_LIMIT)
  public limit = DEFAULT_MEMORY_ANALYSIS_LIMIT;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public offset = 0;

  @ApiPropertyOptional({ example: 'zh-CN', default: 'zh-CN' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  public lang?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  public debugFirstPass = false;
}
