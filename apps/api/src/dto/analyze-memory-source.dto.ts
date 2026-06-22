import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class AnalyzeMemorySourceDto {
  @ApiPropertyOptional({ default: 10, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  public limit = 10;

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
}
