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
  @ApiOperation({ summary: 'Build the user profile page model from facts and insights' })
  public getProfile(@CurrentContext() context: Mem9RequestContext) {
    return this.service.getProfile(context);
  }
}
