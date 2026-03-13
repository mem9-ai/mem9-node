import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface Mem9RequestContext {
  apiKeyFingerprint: Buffer;
  apiKeyFingerprintHex: string;
  requestId: string;
}

export interface Mem9FastifyRequest extends FastifyRequest {
  mem9Context?: Mem9RequestContext;
}

export const CurrentContext = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): Mem9RequestContext => {
    const request = executionContext.switchToHttp().getRequest<Mem9FastifyRequest>();

    if (request.mem9Context === undefined) {
      throw new Error('Request context is not initialized');
    }

    return request.mem9Context;
  },
);
