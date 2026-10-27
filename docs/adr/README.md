# Architecture Decision Records

| #                                                             | Decision                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [0001](0001-transactional-outbox.md)                          | Transactional outbox with a single leader publisher                        |
| [0002](0002-partition-by-recipient-with-keyed-concurrency.md) | Partition by recipient, process recipients concurrently within a partition |
| [0003](0003-at-least-once-with-idempotency-at-every-hop.md)   | At-least-once delivery with idempotency at every hop                       |
| [0004](0004-tiered-retry-topics-and-dead-letter.md)           | Tiered retry topics and a dead-letter topic                                |
| [0005](0005-provider-failover-with-circuit-breakers.md)       | Provider failover with per-process circuit breakers                        |
| [0006](0006-fleet-wide-rate-limiting.md)                      | Fleet-wide rate limiting with a Redis token bucket and spill-over          |
