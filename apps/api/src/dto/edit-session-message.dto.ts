import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class EditSessionMessageDto {
  @ApiProperty({ example: 'Corrected session message content.' })
  @IsString()
  public content!: string;

  @ApiPropertyOptional({ type: [String], example: ['project', 'preference'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public tags?: string[];

  @ApiPropertyOptional({ example: 'User corrected the evidence from the report.' })
  @IsOptional()
  @IsString()
  public reason?: string;
}
