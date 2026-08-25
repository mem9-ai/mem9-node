import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from './common/api-key.guard';
import { RateLimitGuard } from './common/rate-limit.guard';
import { CurrentContext } from './common/request-context';
import type { Mem9RequestContext } from './common/request-context';
import { UserProfileService } from './user-profile.service';

@ApiTags('user-profile')
@ApiHeader({
  name: 'x-mem9-api-key',
  required: true,
  description: 'MEM9 API key forwarded by the browser; this service stores only its fingerprint.',
})
@Controller('v1/user-profile')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class UserProfileController {
  public constructor(private readonly service: UserProfileService) {}

  @Get()
  @ApiOperation({
    summary: 'Build the user profile page model from facts and insights',
    description: 'Generated `summary.text`, `summary.message`, `items[].title`, and `items[].summary` follow the dominant language of the source memories. English persona summaries address the user directly with `You are ...`. Evidence quotes preserve the original memory text.',
  })
  public getProfile(@CurrentContext() context: Mem9RequestContext) {
    return this.service.getProfile(context);
  }
}
