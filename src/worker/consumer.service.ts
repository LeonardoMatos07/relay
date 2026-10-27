import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Consumer, EachBatchPayload, KafkaMessage } from 'kafkajs';
import { Config, CONFIG } from '../config';
import { KeyedExecutor } from '../core/keyed-executor';
import { Channel, MessageEnvelope, topics } from '../core/message';
import { DEFAULT_TIERS } from '../core/retry-policy';
import { KafkaService } from '../infra/kafka.service';
import { DeliveryService, NOT_BEFORE_HEADER } from './delivery.service';

const PARTITIONS_PER_CONSUMER = Number(process.env.WORKER_PARTITION_CONCURRENCY ?? 4);

/**
 * Two consumer groups per channel:
 *
 * - `relay-<channel>` reads the main topic.
 * - `relay-<channel>-retry` reads the retry tiers. A message that is not due yet pauses its
 *   partition until it is; since every message in a tier has the same delay, the ones behind
 *   it are not due either, so nothing is held back that could run.
 *
 * Offsets are resolved by hand, only up to the last message whose handling finished. A crash
 * or rebalance mid-batch therefore replays unfinished messages; the delivery service skips the
 * ones that already reached a final state.
 */
@Injectable()
export class ConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ConsumerService.name);
  private readonly consumers: Consumer[] = [];

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly kafka: KafkaService,
    private readonly delivery: DeliveryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.kafka.ensureTopics();
    await this.kafka.getProducer();
    for (const channel of this.config.workerChannels) {
      await this.start(`relay-${channel}`, [topics.main(channel)], (p) => this.processMain(channel, p));
      await this.start(
        `relay-${channel}-retry`,
        DEFAULT_TIERS.map((t) => topics.retry(channel, t.tier)),
        (p) => this.processRetry(channel, p),
      );
    }
    this.logger.log(`consuming channels: ${this.config.workerChannels.join(', ')}`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.consumers.map((c) => c.stop()));
  }

  private async start(
    groupId: string,
    topicList: string[],
    handler: (payload: EachBatchPayload) => Promise<void>,
  ): Promise<void> {
    const consumer = this.kafka.createConsumer({
      groupId,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      allowAutoTopicCreation: false,
    });
    await consumer.connect();
    await consumer.subscribe({ topics: topicList, fromBeginning: true });
    await consumer.run({
      eachBatchAutoResolve: false,
      autoCommit: true,
      autoCommitInterval: 1_000,
      partitionsConsumedConcurrently: PARTITIONS_PER_CONSUMER,
      eachBatch: handler,
    });
    this.consumers.push(consumer);
  }

  private async processMain(channel: Channel, payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, isRunning, isStale, commitOffsetsIfNecessary } = payload;
    const executor = new KeyedExecutor(this.config.workerKeyConcurrency);
    let lastOffset: string | undefined;

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;
      await this.dispatch(channel, message, executor);
      lastOffset = message.offset;
    }
    await this.drainWithHeartbeat(executor, payload);
    if (lastOffset !== undefined) {
      resolveOffset(lastOffset);
      await commitOffsetsIfNecessary();
    }
  }

  private async processRetry(channel: Channel, payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, isRunning, isStale, commitOffsetsIfNecessary, pause } = payload;
    const executor = new KeyedExecutor(this.config.workerKeyConcurrency);
    let lastOffset: string | undefined;

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;
      const waitMs = notBefore(message) - Date.now();
      if (waitMs > 0) {
        // Finish and commit what was started, then park the partition until this one is due.
        await this.drainWithHeartbeat(executor, payload);
        if (lastOffset !== undefined) {
          resolveOffset(lastOffset);
          await commitOffsetsIfNecessary();
        }
        const resume = pause();
        setTimeout(resume, waitMs).unref();
        return;
      }
      await this.dispatch(channel, message, executor);
      lastOffset = message.offset;
    }
    await this.drainWithHeartbeat(executor, payload);
    if (lastOffset !== undefined) {
      resolveOffset(lastOffset);
      await commitOffsetsIfNecessary();
    }
  }

  private async dispatch(channel: Channel, message: KafkaMessage, executor: KeyedExecutor): Promise<void> {
    const envelope = parseEnvelope(message);
    if (!envelope) {
      await this.delivery.deadLetterRaw(channel, message.value, 'malformed envelope');
      return;
    }
    const key = message.key?.toString('utf8') ?? envelope.id;
    executor.submit(key, () => this.delivery.handle(envelope));
  }

  /** Keeps the group membership alive while a large batch is still being delivered. */
  private async drainWithHeartbeat(executor: KeyedExecutor, payload: EachBatchPayload): Promise<void> {
    const timer = setInterval(() => void payload.heartbeat().catch(() => undefined), 3_000);
    try {
      await executor.drain();
    } finally {
      clearInterval(timer);
    }
  }
}

function notBefore(message: KafkaMessage): number {
  const raw = message.headers?.[NOT_BEFORE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value?.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseEnvelope(message: KafkaMessage): MessageEnvelope | undefined {
  if (!message.value) return undefined;
  try {
    const parsed = JSON.parse(message.value.toString('utf8')) as Partial<MessageEnvelope>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.channel !== 'string' ||
      typeof parsed.to !== 'string' ||
      typeof parsed.body !== 'string' ||
      typeof parsed.acceptedAt !== 'number' ||
      typeof parsed.attempt !== 'number'
    ) {
      return undefined;
    }
    return parsed as MessageEnvelope;
  } catch {
    return undefined;
  }
}
