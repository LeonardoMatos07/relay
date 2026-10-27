import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Config, CONFIG } from '../config';

/** Static API keys in `X-Api-Key`. Enough for a service-to-service API behind a gateway. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly keys: Buffer[];

  constructor(@Inject(CONFIG) config: Config) {
    this.keys = config.apiKeys.map((k) => Buffer.from(k));
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.keys.length === 0) return true;
    const header = context.switchToHttp().getRequest<Request>().header('x-api-key');
    if (header) {
      const given = Buffer.from(header);
      if (this.keys.some((k) => k.length === given.length && timingSafeEqual(k, given))) return true;
    }
    throw new UnauthorizedException('missing or invalid X-Api-Key');
  }
}
