import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Config, CONFIG } from '../config';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(@Inject(CONFIG) config: Config) {
    this.client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 2,
      enableAutoPipelining: true,
      // Only workers use Redis; other roles never open the connection.
      lazyConnect: true,
    });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'wait') this.client.disconnect();
    else await this.client.quit();
  }
}
