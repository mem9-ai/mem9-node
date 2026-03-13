import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export class MemoryDto {
  @ApiProperty()
  @IsString()
  public id!: string;

  @ApiProperty()
  @IsString()
  public content!: string;

  @ApiProperty()
  @IsDateString()
  public createdAt!: string;

  @ApiProperty({ additionalProperties: true })
  @IsObject()
  public metadata!: Record<string, unknown>;
}

export class UploadAnalysisBatchDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public batchHash?: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  public memoryCount!: number;

  @ApiProperty({ type: [MemoryDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MemoryDto)
  public memories!: MemoryDto[];
}
