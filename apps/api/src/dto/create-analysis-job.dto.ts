import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsObject, IsPositive, IsString, ValidateNested } from 'class-validator';

export class DateRangeDto {
  @ApiProperty()
  @IsDateString()
  public start!: string;

  @ApiProperty()
  @IsDateString()
  public end!: string;
}

export class AnalysisOptionsDto {
  @ApiProperty({ example: 'zh-CN' })
  @IsString()
  public lang!: string;

  @ApiProperty({ example: 'v3' })
  @IsString()
  public taxonomyVersion!: string;

  @ApiProperty()
  @IsBoolean()
  public llmEnabled!: boolean;

  @ApiProperty()
  @IsBoolean()
  public includeItems!: boolean;

  @ApiProperty()
  @IsBoolean()
  public includeSummary!: boolean;
}

export class CreateAnalysisJobDto {
  @ApiProperty({ type: DateRangeDto })
  @ValidateNested()
  @Type(() => DateRangeDto)
  public dateRange!: DateRangeDto;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  public expectedTotalMemories!: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  public expectedTotalBatches!: number;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  public batchSize!: number;

  @ApiProperty({ type: AnalysisOptionsDto })
  @ValidateNested()
  @Type(() => AnalysisOptionsDto)
  @IsObject()
  public options!: AnalysisOptionsDto;
}
