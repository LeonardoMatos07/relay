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
  {
    id: '002_receipts_and_suppressions',
    sql: `
      -- What the provider said later about a message (delivered, bounced, complained...).
      -- Distinct from messages.status, which only says whether the provider accepted it.
      ALTER TABLE messages
        ADD COLUMN delivery_status text NOT NULL DEFAULT 'pending'
        CHECK (delivery_status IN ('pending', 'sent', 'delayed', 'delivered', 'bounced', 'rejected', 'complained'));

      CREATE INDEX messages_provider_message_idx ON messages (provider, provider_message_id)
        WHERE provider_message_id IS NOT NULL;

      -- The id is the provider event's stable id, so a receipt delivered twice is stored once.
      CREATE TABLE receipts (
        id          text PRIMARY KEY,
        message_id  uuid NOT NULL REFERENCES messages (id),
        provider    text NOT NULL,
        type        text NOT NULL,
        permanent   boolean,
        reason      text,
        occurred_at timestamptz NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX receipts_message_idx ON receipts (message_id, occurred_at);

      -- Recipients that bounced for good or complained: the API refuses to send to them again.
      CREATE TABLE suppressions (
        channel    text NOT NULL,
        recipient  text NOT NULL,
        reason     text NOT NULL,
        receipt_id text REFERENCES receipts (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (channel, recipient)
      );
    `,
  },
];
