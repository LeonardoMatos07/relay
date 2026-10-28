import { Injectable } from '@nestjs/common';
import { MessageEnvelope, MessageStatus, partitionKey, SendRequest, topics } from '../core/message';
import type { DeliveryStatus } from '../core/receipt';
import { uuidv7 } from '../core/uuidv7';
import { DatabaseService } from '../infra/database.service';

export type AcceptResult =
  | { kind: 'created'; id: string }
  | { kind: 'replayed'; id: string; status: MessageStatus }
  | { kind: 'conflict'; id: string };

export interface MessageView {
  id: string;
  channel: string;
  to: string;
  status: MessageStatus;
  /** What the provider reported afterwards (see receipts); `pending` until it reports. */
  delivery: DeliveryStatus;
  attempts: number;
  provider: string | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

@Injectable()
export class MessagesRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Stores the message and its outbox row in one transaction.
   *
   * Either both exist or neither does, so a message is never accepted without being queued and
   * never queued without being recorded, whatever happens to Kafka at that moment. The API's
   * availability depends on Postgres only.
   */
  async accept(request: SendRequest, fingerprint: string, idempotencyKey?: string): Promise<AcceptResult> {
    const id = uuidv7();
    const acceptedAt = Date.now();
    return this.db.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages (id, idempotency_key, fingerprint, channel, recipient, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::bigint / 1000.0))
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [id, idempotencyKey ?? null, fingerprint, request.channel, request.to, request, acceptedAt],
      );

      if (inserted.rowCount === 0) {
        const existing = await client.query<{ id: string; fingerprint: string; status: MessageStatus }>(
          'SELECT id, fingerprint, status FROM messages WHERE idempotency_key = $1',
          [idempotencyKey],
        );
        const row = existing.rows[0]!;
        return row.fingerprint === fingerprint
          ? { kind: 'replayed', id: row.id, status: row.status }
          : { kind: 'conflict', id: row.id };
      }

      const envelope: MessageEnvelope = { ...request, id, acceptedAt, attempt: 0 };
      await client.query('INSERT INTO outbox (topic, key, payload) VALUES ($1, $2, $3)', [
        topics.main(request.channel),
        partitionKey(request),
        envelope,
      ]);
      return { kind: 'created', id };
    });
  }

  async find(id: string): Promise<MessageView | undefined> {
    const { rows } = await this.db.pool.query<{
      id: string;
      channel: string;
      recipient: string;
      status: MessageStatus;
      delivery_status: DeliveryStatus;
      attempts: number;
      provider: string | null;
      last_error: string | null;
      created_at: Date;
      delivered_at: Date | null;
    }>(
      `SELECT id, channel, recipient, status, delivery_status, attempts, provider, last_error, created_at, delivered_at
       FROM messages WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      id: r.id,
      channel: r.channel,
      to: r.recipient,
      status: r.status,
      delivery: r.delivery_status,
      attempts: r.attempts,
      provider: r.provider,
      lastError: r.last_error,
      createdAt: r.created_at.toISOString(),
      deliveredAt: r.delivered_at?.toISOString() ?? null,
    };
  }
}
