# 1. Transactional outbox with a single leader publisher

- **Status:** Accepted

## Context

Accepting a message means two writes: record it (so its status can be queried and retries
tracked) and queue it (so a worker delivers it). Writing to Postgres and then producing to
Kafka from the request handler is a dual write: if the process dies or Kafka is unavailable
between the two, the message is recorded but never sent, or sent but never recorded.

It would also make the API's availability the product of Postgres's and Kafka's.

## Decision

- The API writes the message **and an outbox row in one Postgres transaction**, then answers
  `202`. Kafka is not on the request path.
- A **publisher** drains the outbox: lock a batch with `FOR UPDATE SKIP LOCKED`, send it to
  Kafka in one producer request (idempotent producer, `acks=all`), delete the rows, commit.
- Only **one publisher is active**, chosen by a Postgres advisory lock held on a dedicated
  connection. A standby retries the lock every second and takes over when the leader's session
  ends. This keeps outbox order, and with it per-recipient order, on the way into Kafka.

## Consequences

- No accepted message can be lost or orphaned; a Kafka outage only grows the outbox, visible
  as `relay_outbox_oldest_age_seconds`, and drains when Kafka returns.
- A crash between "sent" and "commit" republishes the batch: delivery into Kafka is
  at-least-once. ADR 3 covers how duplicates are made harmless.
- One active publisher is a throughput ceiling. Batches of 1,000 rows per round trip put that
  ceiling far above the API's; if it is ever reached, the outbox can be sharded by channel with
  one lock per shard, keeping order per shard.
- Polling adds up to `PUBLISHER_IDLE_MS` (20 ms) of latency when the outbox is empty.
  `LISTEN/NOTIFY` could remove it, at the cost of another moving part.
