# 4. Tiered retry topics and a dead-letter topic

- **Status:** Accepted

## Context

When every provider for a channel fails, the message must be retried later. Options:

- **Retry in place** (sleep inside the consumer): blocks the partition, so one bad message
  stalls every recipient behind it.
- **Re-publish to the main topic:** retried immediately, in a tight loop, during the outage.
- **A delay queue with per-message timers:** Kafka has none.

## Decision

- Three **retry topics per channel**, each with one fixed delay: 5 s, 30 s, 5 min. Attempt N
  goes to tier N with a `not-before` header.
- Because every message in a tier waits the same delay, messages become due in arrival order.
  The retry consumer processes due messages and, at the first one that is not due, commits what
  it finished and **pauses that partition until it is**. No sleeping consumer, no timer per
  message.
- After the last tier, or immediately for non-retryable errors (4xx from the provider), the
  message goes to the **dead-letter topic** with the error, and its status becomes `failed`.
- Malformed records that cannot even be parsed also go to the DLQ, so a poison message never
  blocks a partition.

## Consequences

- Outages are absorbed without hammering the providers and without blocking healthy traffic.
- A message gives up after about 5.5 minutes of failures. The tiers are configuration, so a
  longer horizon (e.g. 30 min) is one more entry.
- The DLQ keeps everything needed to replay a message once the cause is fixed. A replay tool is
  listed as a next step.
- 3 extra topics per channel. They carry a small fraction of the traffic and get a quarter of
  the main topic's partitions.
