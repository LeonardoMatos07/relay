import { Inject, Injectable, Logger } from '@nestjs/common';
import { Config, CONFIG } from '../config';
import { DeliveryError, InfrastructureError } from '../core/delivery-error';
import { MessageEnvelope, partitionKey, topics } from '../core/message';
import { ProviderCall, ProviderConfig, ProviderRouter } from '../core/provider-router';
import { decideRetry } from '../core/retry-policy';
import { KafkaService } from '../infra/kafka.service';
import { deadLettered, deliveries, duplicatesSkipped, endToEndLatency, retriesScheduled } from '../infra/metrics';
import { RateLimiter } from './rate-limiter.service';
import { WorkerRepository } from './worker.repository';

export const NOT_BEFORE_HEADER = 'not-before';

/** Injection token for the adapter dispatcher (see providers/index.ts). */
export const PROVIDER_CALL = Symbol('PROVIDER_CALL');

/**
 * One delivery attempt for one message: route it to a provider (with failover), then record
 * the outcome and, if it failed, schedule a retry or dead-letter it.
 *
 * Errors thrown from here are infrastructure errors (Postgres, Kafka). They propagate to the
 * consumer, which does not commit the offset, so the batch is redelivered and nothing is lost.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly router: ProviderRouter,
    private readonly limiter: RateLimiter,
    private readonly repository: WorkerRepository,
    private readonly kafka: KafkaService,
    @Inject(PROVIDER_CALL) private readonly callProvider: ProviderCall,
  ) {}

  async handle(envelope: MessageEnvelope): Promise<void> {
    if (await this.repository.isFinal(envelope.id)) {
      duplicatesSkipped.inc({ channel: envelope.channel });
      return;
    }

    const route = await this.router.send(envelope, (provider, env) => this.rateLimitedCall(provider, env));
    const attempt = envelope.attempt + 1;

    for (const a of route.attempts) {
      deliveries.inc({ channel: envelope.channel, provider: a.provider, outcome: a.outcome });
    }

    if (route.result) {
      await this.repository.markDelivered(envelope.id, attempt, route.result.provider, route.result.providerMessageId);
      endToEndLatency.observe({ channel: envelope.channel }, (Date.now() - envelope.acceptedAt) / 1000);
      return;
    }

    const error = route.error ?? new DeliveryError('unknown delivery failure', true, false);
    const decision = decideRetry(attempt, error.retryable, Date.now());
    const next: MessageEnvelope = { ...envelope, attempt };

    if (decision.kind === 'retry') {
      await this.kafka.send(topics.retry(envelope.channel, decision.tier.tier), {
        key: partitionKey(envelope),
        value: JSON.stringify(next),
        headers: { [NOT_BEFORE_HEADER]: String(decision.notBefore) },
      });
      await this.repository.recordFailedAttempt(envelope.id, attempt, error.message);
      retriesScheduled.inc({ channel: envelope.channel, tier: String(decision.tier.tier) });
      return;
    }

    await this.kafka.send(topics.dlq(envelope.channel), {
      key: partitionKey(envelope),
      value: JSON.stringify({ ...next, error: error.message, reason: decision.reason }),
    });
    await this.repository.markFailed(envelope.id, attempt, `${decision.reason}: ${error.message}`);
    deadLettered.inc({ channel: envelope.channel, reason: error.retryable ? 'exhausted' : 'non_retryable' });
    this.logger.warn(`dead-lettered ${envelope.id}: ${decision.reason}: ${error.message}`);
  }

  /** Publishes something that could not even be parsed, so it is kept for inspection. */
  async deadLetterRaw(channel: MessageEnvelope['channel'], raw: Buffer | null, reason: string): Promise<void> {
    await this.kafka.send(topics.dlq(channel), {
      key: null,
      value: JSON.stringify({ reason, raw: raw?.toString('utf8') ?? null }),
    });
    deadLettered.inc({ channel, reason: 'malformed' });
  }

  private async rateLimitedCall(provider: ProviderConfig, envelope: MessageEnvelope) {
    let allowed: boolean;
    try {
      allowed = await this.limiter.acquire(provider, this.config.rateLimitMaxWaitMs);
    } catch (err) {
      // Redis is down: stop rather than exceed a paid contract (ADR 6).
      throw new InfrastructureError(`rate limiter unavailable: ${(err as Error).message}`, err);
    }
    if (!allowed) {
      // Saturated, not broken: retryable, and it must not count against the provider's circuit.
      throw new DeliveryError(`rate limit reached for ${provider.name}`, true, false, 429);
    }
    return this.callProvider(provider, envelope);
  }
}
