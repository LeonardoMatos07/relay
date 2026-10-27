import { Controller, Get, Inject, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { Config, CONFIG } from '../config';
import { DatabaseService } from './database.service';
import { KafkaService } from './kafka.service';
import { registry } from './metrics';
import { RedisService } from './redis.service';

/**
 * Liveness, readiness and Prometheus metrics, served by every role.
 *
 * Liveness only says the event loop answers; it must not check dependencies, or a Postgres
 * blip would make Kubernetes restart every pod at once. Readiness checks what this role needs.
 */
@Controller()
export class OpsController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly db: DatabaseService,
    private readonly kafka: KafkaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready() {
    const checks: Record<string, string> = {};
    const run = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        checks[name] = 'ok';
      } catch (err) {
        checks[name] = (err as Error).message;
      }
    };
    await run('postgres', () => this.db.ping());
    if (this.config.role === 'worker') await run('redis', () => this.redis.ping());
    if (this.config.role !== 'api') {
      checks.kafka = this.kafka.isProducerReady() ? 'ok' : 'producer not connected';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    if (!ok) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', role: this.config.role, checks };
  }

  @Get('metrics')
  async metrics(@Res() res: Response): Promise<void> {
    res.setHeader('content-type', registry.contentType);
    res.send(await registry.metrics());
  }
}
