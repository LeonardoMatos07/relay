import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Message } from 'kafkajs';
import type { PoolClient } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { Config, CONFIG } from '../config';
import { backoffWithJitter } from '../core/retry-policy';
import { DatabaseService, LOCKS } from '../infra/database.service';
import { KafkaService } from '../infra/kafka.service';
import { outboxOldestAge, outboxPublished, publisherIsLeader } from '../infra/metrics';

interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: unknown;
}

/**
 * Drains the outbox table into Kafka.
 *
 * Only one publisher is active at a time: it holds a Postgres advisory lock on a dedicated
 * connection. Standby replicas retry the lock and take over within a second if the leader
 * dies (the lock is released when its session ends). A single active publisher keeps outbox
 * order, and therefore per-recipient order, on the way into Kafka.
 *
 * Each batch: lock rows, send them in one producer request, delete them, commit. If the send
 * fails the transaction rolls back and the rows are retried. If the process dies after the
 * send but before the commit, the rows are sent again: delivery into Kafka is at-least-once,
 * and workers skip messages that are already final.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisher.name);
  private running = false;
  private loop?: Promise<void>;
  private leaderClient?: PoolClient;
  private lagTimer?: NodeJS.Timeout;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly db: DatabaseService,
    private readonly kafka: KafkaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.kafka.ensureTopics();
    await this.kafka.getProducer();
    this.running = true;
    this.loop = this.run();
    this.lagTimer = setInterval(() => void this.reportLag(), 5_000);
  }

  /** Runs before the pool and producer close, so the in-flight batch finishes cleanly. */
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.lagTimer) clearInterval(this.lagTimer);
    await this.loop;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        if (!(await this.ensureLeadership())) {
          await sleep(1_000);
          continue;
        }
        const published = await this.publishBatch();
        failures = 0;
        if (published < this.config.publisherBatchSize) await sleep(this.config.publisherIdleMs);
      } catch (err) {
        failures += 1;
        this.logger.error(`publish failed (attempt ${failures}): ${(err as Error).message}`);
        await this.dropLeadershipIfBroken();
        await sleep(backoffWithJitter(failures, 200, 10_000));
      }
    }
    await this.releaseLeadership();
  }

  private async ensureLeadership(): Promise<boolean> {
    if (this.leaderClient) return true;
    const client = await this.db.pool.connect();
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      LOCKS.publisherLeader,
    ]);
    if (rows[0]?.locked) {
      this.leaderClient = client;
      client.on('error', () => void this.dropLeadershipIfBroken());
      publisherIsLeader.set(1);
      this.logger.log('acquired publisher leadership');
      return true;
    }
    client.release();
    publisherIsLeader.set(0);
    return false;
  }

  private async publishBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<OutboxRow>(
        `SELECT id, topic, key, payload FROM outbox ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.config.publisherBatchSize],
      );
      if (rows.length === 0) return 0;

      const byTopic = new Map<string, Message[]>();
      for (const row of rows) {
        const list = byTopic.get(row.topic) ?? [];
        list.push({ key: row.key, value: JSON.stringify(row.payload) });
        byTopic.set(row.topic, list);
      }
      await this.kafka.sendBatch(byTopic);
      await tx.query('DELETE FROM outbox WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      outboxPublished.inc(rows.length);
      return rows.length;
    });
  }

  private async reportLag(): Promise<void> {
    try {
      const { rows } = await this.db.pool.query<{ age: number | null }>(
        `SELECT EXTRACT(EPOCH FROM now() - created_at)::float AS age FROM outbox ORDER BY id LIMIT 1`,
      );
      outboxOldestAge.set(rows[0]?.age ?? 0);
    } catch {
      // metrics must never take the publisher down
    }
  }

  private async dropLeadershipIfBroken(): Promise<void> {
    if (!this.leaderClient) return;
    try {
      await this.leaderClient.query('SELECT 1');
    } catch {
      this.leaderClient.release(true);
      this.leaderClient = undefined;
      publisherIsLeader.set(0);
      this.logger.warn('lost publisher leadership (connection broken)');
    }
  }

  private async releaseLeadership(): Promise<void> {
    if (!this.leaderClient) return;
    await this.leaderClient.query('SELECT pg_advisory_unlock($1)', [LOCKS.publisherLeader]).catch(() => undefined);
    this.leaderClient.release();
    this.leaderClient = undefined;
    publisherIsLeader.set(0);
  }
}
