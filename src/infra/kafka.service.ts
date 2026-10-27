import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Admin, CompressionTypes, Consumer, ConsumerConfig, Kafka, logLevel, Message, Producer } from 'kafkajs';
import { Config, CONFIG } from '../config';
import { CHANNELS, topics } from '../core/message';
import { DEFAULT_TIERS } from '../core/retry-policy';

@Injectable()
export class KafkaService implements OnApplicationShutdown {
  private readonly logger = new Logger(KafkaService.name);
  private readonly kafka: Kafka;
  private producer?: Producer;
  private readonly consumers: Consumer[] = [];
  private producerReady = false;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    this.kafka = new Kafka({
      clientId: config.kafkaClientId,
      brokers: config.kafkaBrokers,
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 300, retries: 8 },
    });
  }

  /**
   * Creates every topic the system uses, if missing. Idempotent, so each role can call it on
   * boot. Retry and dead-letter topics get fewer partitions: they carry a fraction of the load.
   */
  async ensureTopics(): Promise<void> {
    const admin: Admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = new Set(await admin.listTopics());
      const wanted = CHANNELS.flatMap((channel) => [
        { topic: topics.main(channel), numPartitions: this.config.topicPartitions },
        ...DEFAULT_TIERS.map((t) => ({
          topic: topics.retry(channel, t.tier),
          numPartitions: Math.max(1, Math.ceil(this.config.topicPartitions / 4)),
        })),
        { topic: topics.dlq(channel), numPartitions: 3 },
      ]).filter((t) => !existing.has(t.topic));
      if (wanted.length === 0) return;
      await admin.createTopics({
        waitForLeaders: true,
        topics: wanted.map((t) => ({ ...t, replicationFactor: this.config.topicReplication })),
      });
      this.logger.log(`created topics: ${wanted.map((t) => t.topic).join(', ')}`);
    } finally {
      await admin.disconnect();
    }
  }

  async getProducer(): Promise<Producer> {
    if (this.producer) return this.producer;
    const producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
    });
    await producer.connect();
    this.producer = producer;
    this.producerReady = true;
    return producer;
  }

  /** Sends messages grouped by topic in one request. acks=all is implied by idempotent mode. */
  async sendBatch(byTopic: Map<string, Message[]>): Promise<void> {
    const producer = await this.getProducer();
    await producer.sendBatch({
      compression: CompressionTypes.GZIP,
      topicMessages: [...byTopic.entries()].map(([topic, messages]) => ({ topic, messages })),
    });
  }

  async send(topic: string, message: Message): Promise<void> {
    await this.sendBatch(new Map([[topic, [message]]]));
  }

  createConsumer(config: ConsumerConfig): Consumer {
    const consumer = this.kafka.consumer(config);
    this.consumers.push(consumer);
    return consumer;
  }

  isProducerReady(): boolean {
    return this.producerReady;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.consumers.map((c) => c.disconnect()));
    if (this.producer) await this.producer.disconnect();
  }
}
