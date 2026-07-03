import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorResponseDto {
  @ApiProperty({ example: 'SESSION_MESSAGE_NOT_FOUND' })
  public code!: string;

  @ApiProperty({ example: 'Session message not found' })
  public message!: string;

  @ApiProperty({ example: '7f4f4d2a-0e6f-4d4a-b8df-b58d0b84573b' })
  public requestId!: string;

  @ApiPropertyOptional({
    additionalProperties: true,
    example: { upstreamStatus: 404, upstreamError: 'not found' },
  })
  public details?: Record<string, unknown>;
}

export class SessionMessageViewDto {
  @ApiProperty({ example: '311b53da-8b45-4493-b093-860361b0915d' })
  public id!: string;

  @ApiProperty({ example: 'I prefer concise answers.' })
  public content!: string;

  @ApiPropertyOptional({ example: '2026-06-22T08:05:03Z' })
  public createdAt?: string;

  @ApiPropertyOptional({ example: '2026-06-27T10:17:52Z' })
  public updatedAt?: string;

  @ApiPropertyOptional({ example: 'session' })
  public memoryType?: string;

  @ApiPropertyOptional({ type: [String], example: ['preference'] })
  public tags?: string[];

  @ApiPropertyOptional({
    nullable: true,
    additionalProperties: true,
    example: { role: 'user', correctness: 'correct', edited: true },
  })
  public metadata?: Record<string, unknown> | null;
}

export class MarkSessionMessageResponseDto {
  @ApiProperty({ example: '311b53da-8b45-4493-b093-860361b0915d' })
  public id!: string;

  @ApiProperty({ enum: ['correct', 'incorrect'], example: 'correct' })
  public correctness!: 'correct' | 'incorrect';

  @ApiProperty({ example: 7 })
  public version!: number;
}

export class SessionMessageEditResponseDto {
  @ApiProperty({ example: '311b53da-8b45-4493-b093-860361b0915d' })
  public id!: string;

  @ApiProperty({ example: 7 })
  public version!: number;

  @ApiPropertyOptional({ enum: ['correct', 'incorrect'], nullable: true, example: 'correct' })
  public correctness?: 'correct' | 'incorrect' | null;

  @ApiProperty({ example: 'Original session message content.' })
  public originalContent!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Corrected session message content.' })
  public editedContent?: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true, example: ['preference'] })
  public tags?: string[] | null;

  @ApiPropertyOptional({ example: '2026-06-22T08:05:03Z' })
  public createdAt?: string;

  @ApiPropertyOptional({ example: '2026-06-27T10:17:52Z' })
  public updatedAt?: string;
}

export class EditSessionMessageResponseDto extends SessionMessageEditResponseDto {
  @ApiProperty({ example: 'session-message-edit-7' })
  public editId!: string;

  @ApiProperty({ type: String, example: 'Corrected session message content.' })
  public declare editedContent: string;

  @ApiProperty({ type: SessionMessageViewDto })
  public session!: SessionMessageViewDto;

  @ApiProperty({ type: String, nullable: true, example: '2026-06-22' })
  public invalidatedPeriodKey!: string | null;
}

export class DeleteSessionMessageEditResponseDto {
  @ApiProperty({ example: '311b53da-8b45-4493-b093-860361b0915d' })
  public id!: string;

  @ApiProperty({ example: true })
  public reverted!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2026-06-22' })
  public invalidatedPeriodKey!: string | null;
}
