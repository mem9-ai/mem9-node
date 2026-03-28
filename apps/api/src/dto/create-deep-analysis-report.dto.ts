import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateDeepAnalysisReportDto {
  @ApiProperty({ example: 'zh-CN' })
  @IsString()
  public lang!: string;

  @ApiProperty({ example: 'Asia/Shanghai' })
  @IsString()
  public timezone!: string;
}
