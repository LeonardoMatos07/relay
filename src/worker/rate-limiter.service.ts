import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { TOKEN_BUCKET_LUA } from '../core/token-bucket';
import { ProviderConfig } from '../core/provider-router';
import { RedisService } from '../infra/redis.service';
import { rateLimitWaits } from '../infra/metrics';

type TakeTokenFn = (
  key: string,
  now: number,
  rate: number,
  burst: number,
  cost: number,
  ttl: number,
) => Promise<[number, number]>;

/**
 * Fleet-wide token bucket per provider (see core/token-bucket.ts).
 *
 * `acquire` waits up to `maxWaitMs` for a token. Past that it gives up, so the router can spill
 * the message over to the next provider instead of queueing behind a saturated one.
 */
@Injectable()
export class RateLimiter {
  private readonly takeToken: TakeTokenFn;

  constructor(redis: RedisService) {
    redis.client.defineCommand('relayTakeToken', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
    const client = redis.client as unknown as { relayTakeToken: TakeTokenFn };
    this.takeToken = client.relayTakeToken.bind(redis.client);
  }

  async acquire(provider: ProviderConfig, maxWaitMs: number): Promise<boolean> {
    const burst = provider.burst ?? provider.ratePerSecond;
    const key = `relay:ratelimit:${provider.name}`;
    const started = Date.now();
    for (;;) {
      const [allowed, retryAfterMs] = await this.takeToken(key, Date.now(), provider.ratePerSecond, burst, 1, 60_000);
      if (allowed === 1) {
        rateLimitWaits.observe({ provider: provider.name }, (Date.now() - started) / 1000);
        return true;
      }
      const waited = Date.now() - started;
      if (waited + retryAfterMs > maxWaitMs) return false;
      await sleep(Math.max(1, retryAfterMs));
    }
  }
}
