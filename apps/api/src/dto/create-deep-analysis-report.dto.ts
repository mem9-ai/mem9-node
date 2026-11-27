import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CreateDeepAnalysisReportDto {
  @ApiProperty({ example: 'zh-CN', minLength: 1, maxLength: 32 })
  @IsString()
  @Length(1, 32)
  public lang!: string;

  @ApiProperty({ example: 'Asia/Shanghai', minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  public timezone!: string;
}
