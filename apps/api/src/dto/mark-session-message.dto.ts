import type { SessionMessageCorrectness } from '@mem9/contracts';
import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class MarkSessionMessageDto {
  @ApiProperty({ enum: ['correct', 'incorrect'] })
  @IsString()
  public correctness!: SessionMessageCorrectness;
}
