import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { Config, CONFIG } from '../config';
import { MIGRATIONS } from './migrations';

/** Arbitrary constants for pg advisory locks; documented here so they never collide. */
export const LOCKS = {
  migrations: 7_301_001,
  publisherLeader: 7_301_002,
} as const;

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(CONFIG) config: Config) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: `relay-${config.role}`,
    });
    this.pool.on('error', (err) => this.logger.error(`idle client error: ${err.message}`));
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async migrate(): Promise<string[]> {
    const client = await this.pool.connect();
    const applied: string[] = [];
    try {
      await client.query('SELECT pg_advisory_lock($1)', [LOCKS.migrations]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
      const done = new Set(rows.map((r) => r.id));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
          await client.query('COMMIT');
          applied.push(m.id);
          this.logger.log(`applied migration ${m.id}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCKS.migrations]).catch(() => undefined);
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
