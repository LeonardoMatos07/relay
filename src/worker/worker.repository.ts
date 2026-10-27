import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../infra/database.service';

/** Status writes made by workers. Every update is guarded so a final state is never undone. */
@Injectable()
export class WorkerRepository {
  constructor(private readonly db: DatabaseService) {}

  /** True when the message is already delivered or failed (a Kafka redelivery to skip). */
  async isFinal(id: string): Promise<boolean> {
    const { rows } = await this.db.pool.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [id]);
    const status = rows[0]?.status;
    return status === 'delivered' || status === 'failed';
  }

  async markDelivered(id: string, attempts: number, provider: string, providerMessageId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE messages
          SET status = 'delivered', attempts = $2, provider = $3, provider_message_id = $4,
              last_error = NULL, delivered_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'accepted'`,
      [id, attempts, provider, providerMessageId],
    );
  }

  async recordFailedAttempt(id: string, attempts: number, error: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE messages SET attempts = $2, last_error = $3, updated_at = now()
        WHERE id = $1 AND status = 'accepted'`,
      [id, attempts, error.slice(0, 500)],
    );
  }

  async markFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE messages SET status = 'failed', attempts = $2, last_error = $3, updated_at = now()
        WHERE id = $1 AND status = 'accepted'`,
      [id, attempts, error.slice(0, 500)],
    );
  }
}
