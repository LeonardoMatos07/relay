import { DynamicModule, Module, Provider } from '@nestjs/common';
import { MessagesController } from './api/messages.controller';
import { MessagesRepository } from './api/messages.repository';
import { ReceiptsController } from './api/receipts.controller';
import { ReceiptsRepository } from './api/receipts.repository';
import { ApiKeyGuard } from './api/api-key.guard';
import { Config, CONFIG } from './config';
import { ProviderRouter } from './core/provider-router';
import { DatabaseService } from './infra/database.service';
import { KafkaService } from './infra/kafka.service';
import { breakerState } from './infra/metrics';
import { OpsController } from './infra/ops.controller';
import { RedisService } from './infra/redis.service';
import { OutboxPublisher } from './publisher/outbox-publisher.service';
import { ConsumerService } from './worker/consumer.service';
import { DeliveryService, PROVIDER_CALL } from './worker/delivery.service';
import { createProviderDispatcher } from './worker/providers/index';
import { RateLimiter } from './worker/rate-limiter.service';
import { WorkerRepository } from './worker/worker.repository';

const BREAKER_GAUGE = { closed: 0, 'half-open': 1, open: 2 } as const;

/**
 * One image, one module, several roles. The role decides which providers are wired in, so an
 * API pod never opens Kafka consumers and a worker never serves /v1/messages.
 */
@Module({})
export class AppModule {
  static forRole(config: Config): DynamicModule {
    const common: Provider[] = [{ provide: CONFIG, useValue: config }, DatabaseService, KafkaService, RedisService];

    const byRole: Record<Config['role'], { controllers: DynamicModule['controllers']; providers: Provider[] }> = {
      api: {
        controllers: [MessagesController, ReceiptsController],
        providers: [MessagesRepository, ReceiptsRepository, ApiKeyGuard],
      },
      publisher: { controllers: [], providers: [OutboxPublisher] },
      worker: {
        controllers: [],
        providers: [
          {
            provide: ProviderRouter,
            useFactory: () => {
              const router = new ProviderRouter(config.providers, undefined, Date.now, Math.random, (name, state) =>
                breakerState.set({ provider: name }, BREAKER_GAUGE[state]),
              );
              for (const p of config.providers) breakerState.set({ provider: p.name }, 0);
              return router;
            },
          },
          { provide: PROVIDER_CALL, useFactory: () => createProviderDispatcher(config.providers) },
          RateLimiter,
          WorkerRepository,
          DeliveryService,
          ConsumerService,
        ],
      },
      migrate: { controllers: [], providers: [] },
    };

    const role = byRole[config.role];
    return {
      module: AppModule,
      controllers: [OpsController, ...(role.controllers ?? [])],
      providers: [...common, ...role.providers],
    };
  }
}
