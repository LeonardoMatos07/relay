/**
 * Forward-only SQL migrations, applied in order by `APP_ROLE=migrate` under an advisory lock.
 * Kept as code so they ship inside the image with no extra files to copy.
 */
export const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: '001_messages_and_outbox',
    sql: `
      CREATE TABLE messages (
        id                  uuid PRIMARY KEY,
        idempotency_key     text UNIQUE,
        fingerprint         text NOT NULL,
        channel             text NOT NULL,
        recipient           text NOT NULL,
        payload             jsonb NOT NULL,
        status              text NOT NULL DEFAULT 'accepted'
                            CHECK (status IN ('accepted', 'delivered', 'failed')),
        attempts            integer NOT NULL DEFAULT 0,
        provider            text,
        provider_message_id text,
        last_error          text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        delivered_at        timestamptz
      );

      -- Operational queries ("what is stuck?") filter by status and age.
      CREATE INDEX messages_status_created_idx ON messages (status, created_at)
        WHERE status <> 'delivered';

      -- Transactional outbox: written in the same transaction as the message, drained to Kafka
      -- by the publisher. Rows are deleted once published, so the table stays small.
      CREATE TABLE outbox (
        id         bigserial PRIMARY KEY,
        topic      text NOT NULL,
        key        text NOT NULL,
        payload    jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
