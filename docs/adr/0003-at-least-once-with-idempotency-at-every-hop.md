# 3. At-least-once delivery with idempotency at every hop

- **Status:** Accepted

## Context

Exactly-once delivery to an external SMS or e-mail gateway is not achievable: the provider can
accept a message and the worker can die before recording it. Every hop in the system can
duplicate: clients retry on timeouts, the publisher can republish a batch (ADR 1), Kafka can
redeliver after a rebalance (ADR 2).

Losing a message is worse than duplicating one, but duplicates of an SMS cost money and
annoy users.

## Decision

The pipeline is at-least-once, and each hop removes the duplicates it can:

| Hop               | Duplicate source                    | Guard                                                                                                                                                                      |
| ----------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client → API      | client retries                      | `Idempotency-Key` header, unique in Postgres. Same key and payload return the original id (`200`, `Idempotent-Replayed: true`); same key, different payload returns `409`. |
| Outbox → Kafka    | republished batch                   | Idempotent producer; consumers tolerate the rest.                                                                                                                          |
| Kafka → worker    | redelivery after crash or rebalance | Worker skips messages already `delivered` or `failed`; status updates are guarded with `WHERE status = 'accepted'`, so a final state is never overwritten.                 |
| Worker → provider | crash after the provider accepted   | The message id is sent as the provider's `Idempotency-Key`.                                                                                                                |

## Consequences

- No acknowledged message is lost, and the common duplicate paths are closed.
- One window remains: a worker that dies after the provider accepted, sending to a provider
  that ignores idempotency keys, can cause a duplicate. That is the inherent limit of talking
  to an external system, and it is stated in the README. Amazon SES (`SendEmail`) and Twilio's
  Messages API are such providers; the simulated providers honour the key.
- Each delivery costs one extra primary-key read (`isFinal`). Cheap compared with an HTTP call
  to a provider, and it keeps duplicates out of the provider bill.
