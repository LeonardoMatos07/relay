# 2. Partition by recipient, process recipients concurrently within a partition

- **Status:** Accepted

## Context

Some messages must arrive in order for the same person: a newer OTP must not be overtaken by
an older one. Kafka only orders within a partition, and a consumer group gives each partition
to one consumer.

The naive consumer handles one message at a time per partition. With a provider that answers
in ~60 ms, that caps a partition at ~16 messages/s; reaching thousands per second would need
hundreds of partitions, which costs broker resources and slows every rebalance.

## Decision

- Messages are keyed by `channel:recipient`, so one recipient always lands on one partition.
- Each topic has `TOPIC_PARTITIONS` partitions (24 by default), which bounds how many worker
  pods can share the load.
- Inside a batch, a **keyed executor** runs different recipients concurrently (up to
  `WORKER_KEY_CONCURRENCY`, 64 by default) and the same recipient sequentially.
- Offsets are resolved only after the whole batch finishes, so a crash replays unfinished work
  instead of skipping it.

## Consequences

- Throughput per partition scales with concurrency instead of with partition count:
  `pods × WORKER_PARTITION_CONCURRENCY × WORKER_KEY_CONCURRENCY` requests can be in flight.
- Order is guaranteed per recipient on the main topic. A message that fails and goes to a
  retry topic can be overtaken by a newer one for the same person; for notifications this is
  the desired behaviour (the newer OTP is the valid one), and it is documented rather than
  hidden.
- A slow batch delays the commit of fast messages in it; a crash then redelivers more than
  strictly needed. ADR 3 makes that safe.
- A very hot recipient is still serialised, by design.
