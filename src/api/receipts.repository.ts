import { Injectable } from '@nestjs/common';
import type { Channel } from '../core/message';
import { advance, suppresses, type DeliveryStatus, type Receipt } from '../core/receipt';
import { DatabaseService } from '../infra/database.service';

export type RecordResult =
  | { kind: 'recorded'; messageId: string; delivery: DeliveryStatus; suppressed: boolean }
  | { kind: 'duplicate'; messageId: string }
  | { kind: 'unknown-message' };

export interface ReceiptView {
  id: string;
  provider: string;
  type: string;
  permanent: boolean | null;
  reason: string | null;
  occurredAt: string;
}

@Injectable()
export class ReceiptsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Stores a receipt, advances the message's delivery status and, for a hard bounce or a
   * complaint, suppresses the recipient, all in one transaction.
   *
   * The receipt id is unique, so the same provider event arriving twice (SQS is at-least-once)
   * is recorded once and answered as a duplicate. The message row is locked while its status
   * advances, so two receipts for the same message cannot overwrite each other.
   */
  async record(receipt: Receipt): Promise<RecordResult> {
    return this.db.transaction(async (client) => {
      const found = await client.query<{ id: string; delivery_status: DeliveryStatus }>(
        receipt.relayMessageId
          ? 'SELECT id, delivery_status FROM messages WHERE id = $1 FOR UPDATE'
          : 'SELECT id, delivery_status FROM messages WHERE provider = $1 AND provider_message_id = $2 FOR UPDATE',
        receipt.relayMessageId ? [receipt.relayMessageId] : [receipt.provider, receipt.providerMessageId],
      );
      const message = found.rows[0];
      if (!message) return { kind: 'unknown-message' };

      const inserted = await client.query(
        `INSERT INTO receipts (id, message_id, provider, type, permanent, reason, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          receipt.id,
          message.id,
          receipt.provider,
          receipt.type,
          receipt.permanent ?? null,
          receipt.reason ?? null,
          receipt.occurredAt,
        ],
      );
      if (inserted.rowCount === 0) return { kind: 'duplicate', messageId: message.id };

      const delivery = advance(message.delivery_status, receipt.type);
      if (delivery !== message.delivery_status) {
        await client.query('UPDATE messages SET delivery_status = $2, updated_at = now() WHERE id = $1', [
          message.id,
          delivery,
        ]);
      }

      const suppressed = suppresses(receipt);
      if (suppressed) {
        await client.query(
          `INSERT INTO suppressions (channel, recipient, reason, receipt_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (channel, recipient) DO NOTHING`,
          [receipt.channel, normalize(receipt.channel, receipt.recipient), receipt.type, receipt.id],
        );
      }
      return { kind: 'recorded', messageId: message.id, delivery, suppressed };
    });
  }

  async forMessage(messageId: string): Promise<ReceiptView[]> {
    const { rows } = await this.db.pool.query<{
      id: string;
      provider: string;
      type: string;
      permanent: boolean | null;
      reason: string | null;
      occurred_at: Date;
    }>(
      'SELECT id, provider, type, permanent, reason, occurred_at FROM receipts WHERE message_id = $1 ORDER BY occurred_at',
      [messageId],
    );
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      type: r.type,
      permanent: r.permanent,
      reason: r.reason,
      occurredAt: r.occurred_at.toISOString(),
    }));
  }

  async isSuppressed(channel: Channel, recipient: string): Promise<boolean> {
    const { rowCount } = await this.db.pool.query('SELECT 1 FROM suppressions WHERE channel = $1 AND recipient = $2', [
      channel,
      normalize(channel, recipient),
    ]);
    return (rowCount ?? 0) > 0;
  }

  async unsuppress(channel: Channel, recipient: string): Promise<boolean> {
    const { rowCount } = await this.db.pool.query('DELETE FROM suppressions WHERE channel = $1 AND recipient = $2', [
      channel,
      normalize(channel, recipient),
    ]);
    return (rowCount ?? 0) > 0;
  }
}

/** E-mail addresses are case-insensitive for our purposes; phone numbers and device tokens are not. */
export function normalize(channel: Channel, recipient: string): string {
  const trimmed = recipient.trim();
  return channel === 'email' ? trimmed.toLowerCase() : trimmed;
}
