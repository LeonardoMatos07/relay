# 6. Fleet-wide rate limiting with a Redis token bucket and spill-over

- **Status:** Accepted

## Context

Provider contracts limit throughput per account (e.g. 1,500 SMS/s), not per pod. With the
worker fleet autoscaling, a per-process limit is wrong by a factor of the replica count, and
exceeding the contract gets messages throttled (429) or the account suspended.

## Decision

- One **token bucket per provider in Redis**, shared by every worker. The check-and-take runs as
  a **Lua script**, which Redis executes atomically, so two workers can never spend the same
  token. The bucket refills lazily from the elapsed time, so idle buckets cost nothing.
- A worker waits for a token up to `RATE_LIMIT_MAX_WAIT_MS` (250 ms). Past that, the attempt
  fails with a retryable, non-circuit error, and the router **spills over to the next
  provider**. A saturated primary sends its overflow to the secondary instead of queueing.
- A pure TypeScript implementation of the same algorithm is the reference used by unit tests.

## Consequences

- The contract is respected regardless of how many pods run.
- Overflow becomes failover, which uses the capacity of every contracted provider.
- Redis is on the hot path: one round trip per delivery. Auto-pipelining batches concurrent
  calls; if Redis is unavailable the workers stop delivering rather than violate contracts,
  which is the conservative choice for a paid, rate-limited resource.
